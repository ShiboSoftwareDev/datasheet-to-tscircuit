import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ModelManifest } from "@/shared/job-types"
import { createStageWorkspace } from "../../infrastructure/artifacts"
import { buildTscircuitSource } from "../../infrastructure/tscircuit"
import {
  assertCircuitEmbedsModel,
  createModelManifest,
  parseModelContract,
  writeIntegratedComponent,
} from "../../modeling"
import { hashValidationInputs, parseValidationPlan, type ValidationRunResult } from "../../spice-validation"
import {
  appendModelLog,
  commitPreparedModelPublication,
  modelArtifact,
  prepareModelPublication,
  readJson,
  updateModelProgress,
} from "../stage-helpers"
import { defineModelStage } from "./stage-factory"

function assertPassingResultMatchesCandidate(input: {
  result: ValidationRunResult
  expected_hashes: ValidationRunResult["hashes"]
  expected_case_ids: readonly string[]
}): void {
  const mismatches: string[] = []
  if (input.result.version !== 1) mismatches.push("result version is not 1")
  if (!input.result.passed) mismatches.push("result is not passing")
  if (input.result.errors.length > 0) mismatches.push("result contains top-level errors")
  for (const key of Object.keys(input.expected_hashes) as Array<keyof typeof input.expected_hashes>) {
    if (input.result.hashes[key] !== input.expected_hashes[key]) mismatches.push(`${key} changed`)
  }
  if (
    JSON.stringify(input.result.cases.map(({ case_id }) => case_id)) !==
    JSON.stringify(input.expected_case_ids)
  ) {
    mismatches.push("validation case order changed")
  }
  if (input.result.cases.some(({ status, errors }) => status !== "passed" || errors.length > 0)) {
    mismatches.push("a validation case is no longer cleanly passing")
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Validated candidate result no longer proves this exact model, manifest, and plan: ${mismatches.join(", ")}`,
    )
  }
}

export const publishModelStage = defineModelStage({
  id: "publish_model",
  depends_on: ["repair_model"],
  async execute({ context, services, dependency_outputs, signal }) {
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "publishing",
      message: "Building and atomically publishing the validated model/component pair",
    })
    const [contract_value, plan_value, result_value, model_source, model_card, manifest_value] =
      await Promise.all([
        readJson(dependency_outputs.repair_model.contract_path),
        readJson(dependency_outputs.repair_model.plan_path),
        readJson(dependency_outputs.repair_model.result_path),
        readFile(dependency_outputs.repair_model.model_path, "utf8"),
        readFile(dependency_outputs.repair_model.model_card_path, "utf8"),
        readJson(dependency_outputs.repair_model.manifest_path),
      ])
    const contract = parseModelContract(contract_value)
    const generated = {
      source: model_source,
      card: model_card,
      manifest: manifest_value as ModelManifest,
    }
    const derived_manifest = createModelManifest({
      model_interface: contract.interface,
      model_source: generated.source,
      simulator: "ngspice",
    })
    const { generated_at: _actual_generated_at, ...actual_manifest_identity } = generated.manifest
    const { generated_at: _derived_generated_at, ...derived_manifest_identity } = derived_manifest
    if (
      generated.manifest.revision !== dependency_outputs.repair_model.revision ||
      !Number.isFinite(Date.parse(generated.manifest.generated_at)) ||
      JSON.stringify(actual_manifest_identity) !== JSON.stringify(derived_manifest_identity)
    ) {
      throw new Error("Validated candidate manifest no longer matches its immutable model and interface")
    }
    const plan = parseValidationPlan(plan_value, {
      manifest: generated.manifest,
      model_source: generated.source,
      model_requirements: contract.characterization.requirements,
    })
    const result = result_value as ValidationRunResult
    assertPassingResultMatchesCandidate({
      result,
      expected_hashes: hashValidationInputs({
        plan: plan_value,
        model_source: generated.source,
        manifest: generated.manifest,
      }),
      expected_case_ids: plan.cases.map(({ id }) => id),
    })

    const publication = await (async () => {
      const integration_workspace = await createStageWorkspace({
        prefix: "model-integration",
        files: [
          { source: join(context.model_dir, "component.circuit.tsx") },
          { source: join(context.model_dir, "component.circuit.json") },
          { source: join(context.model_dir, "model-interface.json") },
          { source: join(context.model_dir, "package.json"), required: false },
          { source: join(context.model_dir, "tsconfig.json"), required: false },
          { source: join(context.model_dir, "tscircuit.config.json"), required: false },
          { source: join(context.model_dir, "tscircuit.config.ts"), required: false },
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
        assertCircuitEmbedsModel(build.circuit_json, generated.source, contract.interface)
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
          evidence_dir: dependency_outputs.repair_model.evidence_dir,
          wrapper_source,
          circuit_json: build.circuit_json,
        })
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
    return {
      status: "completed",
      commit_state: "committed",
      output: {
        attached: true,
        component_path: publication.component_path,
        revision: dependency_outputs.repair_model.revision,
      },
      artifacts: publication.artifacts,
    }
  },
})
