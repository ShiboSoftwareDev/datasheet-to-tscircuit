import { writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ValidationRunResult } from "../../spice-validation"
import { modelArtifact, readJson, updateModelProgress } from "../stage-helpers"
import { defineModelStage } from "./stage-factory"

export const compareSimulationOutputsStage = defineModelStage({
  id: "compare_simulation_outputs",
  depends_on: ["run_simulations"],
  async execute({ context, services, dependency_outputs }) {
    const simulations = dependency_outputs.run_simulations
    const result = (await readJson(simulations.result_path)) as ValidationRunResult
    const failing_case_ids = result.cases
      .filter(({ status }) => status !== "passed")
      .map(({ case_id }) => case_id)
    const passed = simulations.passed && result.passed && failing_case_ids.length === 0
    const comparison_path = join(dirname(simulations.result_path), "simulation-comparison.json")
    await writeFile(
      comparison_path,
      `${JSON.stringify(
        {
          version: 1,
          model_revision: simulations.revision,
          passed,
          case_count: result.cases.length,
          passing_case_count: result.cases.length - failing_case_ids.length,
          failing_case_ids,
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
      phase: passed ? "publishing" : "repairing",
      message: passed
        ? "Simulation outputs match the datasheet comparison graphs"
        : "Simulation comparison found differences to repair",
    })
    return {
      status: "completed",
      output: {
        result_path: simulations.result_path,
        model_path: simulations.model_path,
        model_card_path: simulations.model_card_path,
        manifest_path: simulations.manifest_path,
        contract_path: simulations.contract_path,
        plan_path: simulations.plan_path,
        evidence_dir: simulations.evidence_dir,
        passed,
        case_count: result.cases.length,
        failing_case_ids: [...new Set([...simulations.failing_case_ids, ...failing_case_ids])],
        ...(simulations.repair_feedback ? { repair_feedback: simulations.repair_feedback } : {}),
        revision: simulations.revision,
      },
      artifacts: [
        await modelArtifact({
          id: "simulation_comparison",
          path: comparison_path,
          media_type: "application/json",
          role: "comparison_result",
        }),
      ],
      metrics: {
        comparison_cases: result.cases.length,
        passing_cases: result.cases.length - failing_case_ids.length,
      },
    }
  },
})
