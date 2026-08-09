import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type GeneratedModel, parseFreshModelContract, renderValidationCaseTsx } from "../../modeling"
import { PipelineError } from "../../pipeline"
import {
  hashValidationInputs,
  sha256Text,
  stableStringify,
  type ValidationExecutionError,
  type ValidationPlan,
  type ValidationRunResult,
} from "../../spice-validation"
import { persistCandidateValidationUi, projectCandidateValidationUi } from "../stage-helpers/candidate-ui"
import {
  attachStimulusCausalityCheck,
  createStimulusCausalityPlan,
  evaluateStimulusCausality,
} from "../candidate-stimulus-causality"
import { appendModelLog, modelArtifact, readJson, updateModelProgress } from "../stage-helpers"
import { readTscircuitSimulationArtifacts } from "../tscircuit-simulation-artifacts"
import {
  compareValidationCircuitSimulations,
  getViewerInfrastructureFailures,
  getViewerPreviewFailures,
} from "../validation-circuit-previews"
import { classifyValidationInfrastructureFailure } from "../validation-repair-policy"
import { defineModelStage } from "./stage-factory"

export const compareSimulationOutputsStage = defineModelStage({
  id: "compare_simulation_outputs",
  depends_on: ["run_simulations"],
  async execute({ context, services, dependency_outputs, signal }) {
    const simulations = dependency_outputs.run_simulations
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "validating",
      message: "Comparing saved tscircuit waveforms with datasheet references",
    })
    const [plan_value, contract_value, model_source, model_card, manifest] = await Promise.all([
      readJson(simulations.plan_path),
      readJson(simulations.contract_path),
      readFile(simulations.model_path, "utf8"),
      readFile(simulations.model_card_path, "utf8"),
      readJson(simulations.manifest_path),
    ])
    const plan = plan_value as ValidationPlan
    const contract = parseFreshModelContract(contract_value)
    const generated: GeneratedModel = {
      source: model_source,
      card: model_card,
      manifest: manifest as GeneratedModel["manifest"],
    }
    const raw_simulations = await readTscircuitSimulationArtifacts({
      receipt_path: simulations.result_path,
      plan,
      generated,
    })
    const preview_build = await compareValidationCircuitSimulations({
      plan,
      generated,
      simulations: raw_simulations,
      append: (stream, message) =>
        appendModelLog(services.model_run_store, context.model_run_id, stream, message),
    })
    const input_hashes = hashValidationInputs({
      plan,
      model_source: generated.source,
      manifest: generated.manifest,
    })
    const cases = await Promise.all(
      plan.cases.map(async (validation_case) => {
        const circuit_json = raw_simulations.circuit_json_by_case[validation_case.id]
        const viewer_validation = preview_build.viewer_validation_by_case[validation_case.id]
        const simulation_error = raw_simulations.simulation_errors_by_case[validation_case.id]
        const errors: ValidationExecutionError[] = simulation_error
          ? [
              {
                kind: "convergence",
                code: "tscircuit_simulation_failed",
                message: simulation_error,
              },
            ]
          : [...(viewer_validation?.errors ?? [])]
        const source = await readFile(
          join(simulations.source_dir, `${validation_case.id}.circuit.tsx`),
          "utf8",
        )
        return {
          case_id: validation_case.id,
          status: viewer_validation?.passed ? ("passed" as const) : ("failed" as const),
          analysis: validation_case.analysis.type,
          series: viewer_validation?.series ?? [],
          errors,
          elapsed_ms: 0,
          netlist_sha256: sha256Text(source),
          raw_sha256: sha256Text(stableStringify(circuit_json ?? [])),
        }
      }),
    )
    let result: ValidationRunResult = {
      version: 1,
      passed: cases.length === plan.cases.length && cases.every(({ status }) => status === "passed"),
      hashes: input_hashes,
      cases,
      errors: cases.flatMap(({ errors }) => errors),
    }
    const causality = createStimulusCausalityPlan({ plan, contract })
    const causality_plan: ValidationPlan = {
      ...causality.plan,
      cases: causality.plan.cases.filter(({ id }) => causality.relevant_observation_ids_by_case.has(id)),
    }
    let stimulus_causality: ReturnType<typeof evaluateStimulusCausality> = {
      required: false,
      passed: true,
    }
    if (causality_plan.cases.length > 0) {
      if (!simulations.causality_result_path) {
        throw new PipelineError({
          code: "model_simulation_comparison_failed",
          message: "Run Simulations did not retain the required tscircuit causality-control results",
          stage_id: "compare_simulation_outputs",
          operation: "load_tscircuit_causality_simulations",
          artifact_refs: [{ path: simulations.result_path }],
        })
      }
      const causality_simulations = await readTscircuitSimulationArtifacts({
        receipt_path: simulations.causality_result_path,
        plan: causality_plan,
        generated,
      })
      const causality_preview_build = await compareValidationCircuitSimulations({
        plan: causality_plan,
        generated,
        simulations: causality_simulations,
        append: (stream, message) =>
          appendModelLog(services.model_run_store, context.model_run_id, stream, message),
      })
      const causality_cases = causality_plan.cases.map((validation_case) => {
        const circuit_json = causality_simulations.circuit_json_by_case[validation_case.id]
        const viewer_validation = causality_preview_build.viewer_validation_by_case[validation_case.id]
        const simulation_error = causality_simulations.simulation_errors_by_case[validation_case.id]
        const errors: ValidationExecutionError[] = simulation_error
          ? [
              {
                kind: "convergence",
                code: "tscircuit_simulation_failed",
                message: simulation_error,
              },
            ]
          : [...(viewer_validation?.errors ?? [])]
        const source = renderValidationCaseTsx({
          validation_case,
          manifest: generated.manifest,
          model_source: generated.source,
          model_card: generated.card,
        })
        return {
          case_id: validation_case.id,
          status: viewer_validation?.passed ? ("passed" as const) : ("failed" as const),
          analysis: validation_case.analysis.type,
          series: viewer_validation?.series ?? [],
          errors,
          elapsed_ms: 0,
          netlist_sha256: sha256Text(source),
          raw_sha256: sha256Text(stableStringify(circuit_json ?? [])),
        }
      })
      const causality_result: ValidationRunResult = {
        version: 1,
        passed:
          causality_cases.length === causality_plan.cases.length &&
          causality_cases.every(({ status }) => status === "passed"),
        hashes: hashValidationInputs({
          plan: causality_plan,
          model_source: generated.source,
          manifest: generated.manifest,
        }),
        cases: causality_cases,
        errors: causality_cases.flatMap(({ errors }) => errors),
      }
      stimulus_causality = evaluateStimulusCausality({
        plan,
        contract,
        manifest: generated.manifest,
        model_source: generated.source,
        baseline_result: result,
        flattened_result: causality_result,
        flattened: causality,
      })
      result = attachStimulusCausalityCheck(result, stimulus_causality)
    }
    const validation_artifact_dir = join(dirname(simulations.model_path), "validation")
    const projection = await persistCandidateValidationUi({
      plan,
      result,
      generated,
      contract,
      immutable_artifact_dir: validation_artifact_dir,
      preview_generation: `${context.invocation_id}-${generated.manifest.revision}`,
      circuit_json_by_case: preview_build.circuit_json_by_case,
      circuit_build_errors_by_case: preview_build.circuit_build_errors_by_case,
      viewer_validation_by_case: preview_build.viewer_validation_by_case,
      viewer_errors_by_case: preview_build.errors_by_case,
    })
    await projectCandidateValidationUi({
      model_run_store: services.model_run_store,
      model_run_id: context.model_run_id,
      model_dir: context.model_dir,
      immutable_artifact_dir: validation_artifact_dir,
      evidence_dir: simulations.evidence_dir,
      revision: generated.manifest.revision,
      projection,
      signal,
    })

    const viewer_failures = getViewerPreviewFailures(preview_build)
    const infrastructure_failure = classifyValidationInfrastructureFailure({
      result,
      viewer_failures: getViewerInfrastructureFailures(preview_build),
    })
    const result_path = join(validation_artifact_dir, "validation-results.json")
    const diagnostic_path = join(validation_artifact_dir, "candidate-diagnostics.json")
    if (infrastructure_failure) {
      const message =
        infrastructure_failure.source === "server_validation"
          ? infrastructure_failure.errors.map(({ code, message }) => `${code}: ${message}`).join("; ")
          : infrastructure_failure.failures.map(({ case_id, message }) => `${case_id}: ${message}`).join("; ")
      throw new PipelineError({
        code: "model_simulation_comparison_failed",
        message: `Saved tscircuit results could not be compared: ${message}`,
        stage_id: "compare_simulation_outputs",
        operation: "compare_tscircuit_waveforms",
        artifact_refs: [{ path: result_path }, { path: diagnostic_path }],
        hint: "Inspect the saved Circuit JSON and comparison diagnostics. Run Simulations is not rerun by this step.",
      })
    }

    const passed = result.passed && viewer_failures.length === 0
    const graph_statistics = projection.validation.benchmarks.map((benchmark) => ({
      graph_id: benchmark.benchmark_id,
      passed: benchmark.passed,
      normalized_rmse: benchmark.normalized_rmse,
      normalized_max_error: benchmark.normalized_max_error,
      series: (benchmark.series ?? []).map((series) => ({
        series_id: series.series_id,
        passed: series.passed,
        normalized_rmse: series.normalized_rmse,
        normalized_max_error: series.normalized_max_error,
      })),
    }))
    const failing_case_ids = graph_statistics
      .filter(({ passed: graph_passed }) => !graph_passed)
      .map(({ graph_id }) => graph_id)
    const series_count = graph_statistics.reduce((count, graph) => count + graph.series.length, 0)
    const passing_series = graph_statistics.reduce(
      (count, graph) => count + graph.series.filter(({ passed: series_passed }) => series_passed).length,
      0,
    )
    const comparison_path = join(validation_artifact_dir, "simulation-comparison.json")
    await writeFile(
      comparison_path,
      `${JSON.stringify(
        {
          version: 1,
          model_revision: simulations.revision,
          passed,
          case_count: cases.length,
          passing_case_count: cases.length - failing_case_ids.length,
          failing_case_ids,
          overall_statistics: {
            score: projection.validation.score,
            worst_normalized_error: projection.validation.worst_normalized_error,
            curve_score: projection.validation.curve_score,
            curve_worst_normalized_error: projection.validation.curve_worst_normalized_error,
            series_count,
            passing_series,
          },
          graphs: graph_statistics,
          reference_result_path: simulations.result_path,
        },
        null,
        2,
      )}\n`,
      "utf8",
    )
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "scoring",
      message: passed
        ? "Simulation comparison complete: every graph matches"
        : "Simulation comparison complete: one or more graphs differ",
    })
    return {
      status: "completed",
      output: {
        result_path,
        model_path: simulations.model_path,
        model_card_path: simulations.model_card_path,
        manifest_path: simulations.manifest_path,
        contract_path: simulations.contract_path,
        plan_path: simulations.plan_path,
        evidence_dir: simulations.evidence_dir,
        passed,
        case_count: cases.length,
        failing_case_ids,
        ...(stimulus_causality.required && !stimulus_causality.passed
          ? {
              stimulus_causality_failure: {
                affected_case_count: stimulus_causality.affected_case_count,
                affected_observation_count: stimulus_causality.affected_observation_count,
              },
            }
          : {}),
        revision: simulations.revision,
      },
      artifacts: [
        await modelArtifact({
          id: "simulation_comparison",
          path: comparison_path,
          media_type: "application/json",
          role: "comparison_result",
        }),
        await modelArtifact({
          id: "comparison_outputs",
          path: result_path,
          media_type: "application/json",
          role: "validation_result",
        }),
      ],
      metrics: {
        comparison_cases: cases.length,
        passing_cases: cases.length - failing_case_ids.length,
        comparison_series: series_count,
        passing_series,
      },
    }
  },
})
