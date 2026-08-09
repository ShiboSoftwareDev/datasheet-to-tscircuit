import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createStageWorkspace } from "../../infrastructure/artifacts"
import { buildTscircuitSource } from "../../infrastructure/tscircuit"
import {
  assertCircuitEmbedsModel,
  assertValidationCircuitEmbedsModel,
  parseModelInterface,
  requireModelCompletionIntegrity,
  validateViewerSimulation,
  writeIntegratedComponent,
} from "../../modeling"
import {
  appendModelLog,
  commitPreparedModelPublication,
  discardPreparedModelPublication,
  modelArtifact,
  prepareModelPublication,
  readJson,
  updateModelProgress,
} from "../stage-helpers"
import { readVerifiedViewerCircuitJson } from "../viewer-validation-artifacts"
import { defineModelStage } from "./stage-factory"

export const publishModelStage = defineModelStage({
  id: "publish",
  depends_on: ["repair_spice_model", "wait_for_component"],
  async execute({ context, services, dependency_outputs, signal }) {
    if (!dependency_outputs.repair_spice_model.passed) {
      const reason =
        "The development model remains unpublished because it did not meet the server-owned validation target"
      updateModelProgress({
        store: services.model_run_store,
        model_run_id: context.model_run_id,
        phase: "finalizing",
        message: reason,
      })
      await appendModelLog(
        services.model_run_store,
        context.model_run_id,
        "system",
        `${reason}. The best development model and its synchronized TSX, simulation, and comparison artifacts remain available.\n`,
      )
      return { status: "skipped", reason }
    }
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "publishing",
      message: "Building and atomically publishing the validated model/component pair",
    })
    const [contract_value, plan_value, result_value, model_source, model_card, manifest_value] =
      await Promise.all([
        readJson(dependency_outputs.repair_spice_model.contract_path),
        readJson(dependency_outputs.repair_spice_model.plan_path),
        readJson(dependency_outputs.repair_spice_model.result_path),
        readFile(dependency_outputs.repair_spice_model.model_path, "utf8"),
        readFile(dependency_outputs.repair_spice_model.model_card_path, "utf8"),
        readJson(dependency_outputs.repair_spice_model.manifest_path),
      ])
    const completion_integrity = requireModelCompletionIntegrity({
      model_source,
      manifest: manifest_value,
      contract: contract_value,
      plan: plan_value,
      result: result_value,
      policy: "fresh_time_voltage_v1",
    })
    const contract = completion_integrity.contract
    const generated = {
      source: model_source,
      card: model_card,
      manifest: completion_integrity.manifest,
    }
    if (generated.manifest.revision !== dependency_outputs.repair_spice_model.revision) {
      throw new Error("Validated candidate manifest no longer matches its immutable model and interface")
    }
    const plan = completion_integrity.plan
    const result = completion_integrity.result
    const component_input = dependency_outputs.wait_for_component
    const integration_interface = parseModelInterface(
      await readJson(component_input.integration_interface_path),
    )
    const circuit_json_by_case = await readVerifiedViewerCircuitJson({
      validation_dir: dirname(dependency_outputs.repair_spice_model.result_path),
      plan,
      generated,
    })
    let prepared_for_cleanup: Awaited<ReturnType<typeof prepareModelPublication>> | undefined
    let publication_committed = false
    try {
      const publication = await (async () => {
        const integration_workspace = await createStageWorkspace({
          prefix: "model-integration",
          files: [
            { source: component_input.component_source_path },
            { source: component_input.component_circuit_json_path },
            { source: component_input.integration_interface_path },
            { source: join(component_input.integration_dir, "package.json"), required: false },
            { source: join(component_input.integration_dir, "tsconfig.json"), required: false },
            { source: join(component_input.integration_dir, "tscircuit.config.json"), required: false },
            { source: join(component_input.integration_dir, "tscircuit.config.ts"), required: false },
          ],
        })
        try {
          const wrapper_source = await writeIntegratedComponent({
            model_dir: integration_workspace.path,
            manifest: generated.manifest,
            model_source: generated.source,
          })
          const build = await buildTscircuitSource({
            workspace: integration_workspace.path,
            source_file: "component-with-model.circuit.tsx",
            output_stem: "component-with-model",
            tsci_bin: services.tsci_bin,
            process_runner: services.process_runner,
            signal,
            ignored_error_types: ["source_pin_must_be_connected_error"],
            on_output: (stream, message) =>
              appendModelLog(services.model_run_store, context.model_run_id, stream, message),
          })
          if (build.errors.length > 0) {
            throw new Error(`Integrated component build failed: ${build.errors.join("; ")}`)
          }
          assertCircuitEmbedsModel(build.circuit_json, generated.source, integration_interface)
          const viewer_failures = plan.cases.flatMap((validation_case) => {
            const circuit_json = circuit_json_by_case[validation_case.id]
            if (!circuit_json) return [`${validation_case.id}: no validation Circuit JSON was retained`]
            try {
              assertValidationCircuitEmbedsModel(circuit_json, generated.source, generated.manifest)
            } catch (error) {
              return [
                `${validation_case.id}: viewer_model_provenance_failed: ${error instanceof Error ? error.message : String(error)}`,
              ]
            }
            const validation = validateViewerSimulation({ validation_case, circuit_json })
            return validation.passed
              ? []
              : [
                  `${validation_case.id}: ${validation.errors
                    .map(({ code, message }) => `${code}: ${message}`)
                    .join("; ")}`,
                ]
          })
          if (viewer_failures.length > 0) {
            throw new Error(
              `Model publication requires a verified tscircuit transient graph for every validation case: ${viewer_failures.join(" | ")}`,
            )
          }
          signal.throwIfAborted()
          const prepared = await prepareModelPublication({
            job_id: context.job_id,
            job_dir: context.job_dir,
            model_dir: context.model_dir,
            model_run_id: context.model_run_id,
            invocation_id: context.invocation_id,
            contract,
            plan,
            result,
            generated,
            evidence_dir: dependency_outputs.repair_spice_model.evidence_dir,
            wrapper_source,
            circuit_json: build.circuit_json,
            circuit_json_by_case,
            process_runner: services.process_runner,
            signal,
          })
          prepared_for_cleanup = prepared
          const component_path = join(prepared.published_component_dir, "index.circuit.tsx")
          const circuit_json_path = join(prepared.published_component_dir, "component.circuit.json")
          const artifacts = await Promise.all([
            modelArtifact({
              id: "integrated_component",
              path: component_path,
              media_type: "text/typescript",
              role: "published_component",
            }),
            modelArtifact({
              id: "integrated_circuit_json",
              path: circuit_json_path,
              media_type: "application/json",
              role: "published_preview",
            }),
          ])
          return { prepared, build, component_path, artifacts }
        } finally {
          await integration_workspace.dispose()
        }
      })()
      signal.throwIfAborted()
      await commitPreparedModelPublication({
        prepared: publication.prepared,
        job_id: context.job_id,
        job_dir: context.job_dir,
        job_store: services.job_store,
        model_dir: context.model_dir,
        model_run_id: context.model_run_id,
        model_run_store: services.model_run_store,
        plan,
        generated,
        circuit_json: publication.build.circuit_json,
        signal,
      })
      publication_committed = true
      return {
        status: "completed",
        commit_state: "committed",
        output: {
          attached: true,
          component_path: publication.component_path,
          revision: dependency_outputs.repair_spice_model.revision,
        },
        artifacts: publication.artifacts,
      }
    } finally {
      if (prepared_for_cleanup && !publication_committed) {
        await discardPreparedModelPublication(prepared_for_cleanup)
      }
    }
  },
})
