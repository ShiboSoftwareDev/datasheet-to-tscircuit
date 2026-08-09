import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type GeneratedModel, parseFreshModelContract } from "../../modeling"
import { PipelineError } from "../../pipeline"
import type { ValidationPlan } from "../../spice-validation"
import { appendModelLog, modelArtifact, readJson, updateModelProgress } from "../stage-helpers"
import { createStimulusCausalityPlan } from "../candidate-stimulus-causality"
import { writeTscircuitSimulationArtifacts } from "../tscircuit-simulation-artifacts"
import { runValidationCircuitSimulations } from "../validation-circuit-previews"
import { defineModelStage } from "./stage-factory"

export const runSimulationsStage = defineModelStage({
  id: "run_simulations",
  depends_on: ["create_simulation_tsx"],
  async execute({ context, services, dependency_outputs, signal }) {
    services.model_run_store.updateModelRun(context.model_run_id, { status: "validating" })
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "validating",
      message: "Running generated TSX simulations with tscircuit",
    })
    const simulation_input = dependency_outputs.create_simulation_tsx
    const { contract_path, plan_path, evidence_dir } = simulation_input
    const [plan_value, contract_value, model_source, model_card, manifest] = await Promise.all([
      readJson(plan_path),
      readJson(contract_path),
      readFile(simulation_input.model_path, "utf8"),
      readFile(simulation_input.model_card_path, "utf8"),
      readJson(simulation_input.manifest_path),
    ])
    const plan = plan_value as ValidationPlan
    const contract = parseFreshModelContract(contract_value)
    const generated: GeneratedModel = {
      source: model_source,
      card: model_card,
      manifest: manifest as GeneratedModel["manifest"],
    }
    const simulation_dir = join(dirname(simulation_input.model_path), "simulation")
    const simulations = await runValidationCircuitSimulations({
      model_dir: context.model_dir,
      plan,
      generated,
      source_dir: simulation_input.source_dir,
      tsci_bin: services.tsci_bin,
      process_runner: services.process_runner,
      signal,
      append: (stream, message) =>
        appendModelLog(services.model_run_store, context.model_run_id, stream, message),
    })
    const result_path = await writeTscircuitSimulationArtifacts({
      simulation_dir,
      plan,
      generated,
      simulations,
    })
    const build_failure_case_ids = plan.cases.flatMap(({ id }) =>
      simulations.circuit_build_errors_by_case[id] ? [id] : [],
    )
    if (build_failure_case_ids.length > 0) {
      throw new PipelineError({
        code: "model_viewer_simulation_failed",
        message: `tsci could not execute ${build_failure_case_ids.length} generated TSX simulation(s): ${build_failure_case_ids.join(", ")}`,
        stage_id: "run_simulations",
        operation: "execute_tscircuit_simulations",
        artifact_refs: [{ path: result_path }],
        hint: "Inspect the retained tscircuit simulation receipt and the named TSX cases. No reference comparison was attempted.",
      })
    }
    const simulation_error_case_ids = plan.cases.flatMap(({ id }) =>
      simulations.simulation_errors_by_case[id] ? [id] : [],
    )
    const causality = createStimulusCausalityPlan({ plan, contract })
    const causality_case_count = causality.relevant_observation_ids_by_case.size
    const causality_plan: ValidationPlan = {
      ...causality.plan,
      cases: causality.plan.cases.filter(({ id }) => causality.relevant_observation_ids_by_case.has(id)),
    }
    let causality_result_path: string | undefined
    let causality_simulation_error_case_ids: string[] = []
    if (causality_case_count > 0) {
      const causality_simulations = await runValidationCircuitSimulations({
        model_dir: context.model_dir,
        plan: causality_plan,
        generated,
        tsci_bin: services.tsci_bin,
        process_runner: services.process_runner,
        signal,
        append: (stream, message) =>
          appendModelLog(services.model_run_store, context.model_run_id, stream, message),
      })
      causality_result_path = await writeTscircuitSimulationArtifacts({
        simulation_dir: join(simulation_dir, "causality-control"),
        plan: causality_plan,
        generated,
        simulations: causality_simulations,
      })
      const causality_build_failure_case_ids = causality_plan.cases.flatMap(({ id }) =>
        causality_simulations.circuit_build_errors_by_case[id] ? [id] : [],
      )
      if (causality_build_failure_case_ids.length > 0) {
        throw new PipelineError({
          code: "model_viewer_simulation_failed",
          message: `tsci could not execute ${causality_build_failure_case_ids.length} causality-control TSX simulation(s): ${causality_build_failure_case_ids.join(", ")}`,
          stage_id: "run_simulations",
          operation: "execute_tscircuit_causality_simulations",
          artifact_refs: [{ path: causality_result_path }],
          hint: "Inspect the retained tscircuit causality-control receipt. No causality comparison was attempted.",
        })
      }
      causality_simulation_error_case_ids = causality_plan.cases.flatMap(({ id }) =>
        causality_simulations.simulation_errors_by_case[id] ? [id] : [],
      )
    }
    return {
      status: "completed",
      output: {
        result_path,
        simulation_dir,
        source_dir: simulation_input.source_dir,
        model_path: simulation_input.model_path,
        model_card_path: simulation_input.model_card_path,
        manifest_path: simulation_input.manifest_path,
        contract_path,
        plan_path,
        evidence_dir,
        case_count: plan.cases.length,
        simulation_error_case_ids,
        ...(causality_result_path ? { causality_result_path } : {}),
        causality_case_count,
        causality_simulation_error_case_ids,
        revision: generated.manifest.revision,
      },
      artifacts: [
        await modelArtifact({
          id: "simulation_outputs",
          path: result_path,
          media_type: "application/json",
          role: "simulation_result",
        }),
        ...(causality_result_path
          ? [
              await modelArtifact({
                id: "causality_simulation_outputs",
                path: causality_result_path,
                media_type: "application/json",
                role: "simulation_result",
              }),
            ]
          : []),
      ],
      metrics: {
        simulation_cases: plan.cases.length + causality_case_count,
        completed_simulations: plan.cases.length - simulation_error_case_ids.length,
        causality_control_simulations: causality_case_count - causality_simulation_error_case_ids.length,
      },
    }
  },
})
