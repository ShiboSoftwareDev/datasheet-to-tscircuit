import { join } from "node:path"
import {
  type ApplicationFixtureContract,
  type ModelInterface,
  parseApplicationFixtureContract,
  parseModelInterface,
} from "../../modeling"
import {
  assertHasEligibleTimeDomainGraph,
  assertObserverFoundEligibleTimeDomainGraph,
} from "../characterization/eligibility"
import { findReferenceGraphs } from "../characterization/source-inventory"
import { materializeFoundReferenceEvidence } from "../found-reference-evidence"
import { projectFoundReferencesUi } from "../found-reference-ui"
import { foundObservedGraphs } from "../reference-graph-observation"
import { modelArtifact, readJson, updateModelProgress } from "../stage-helpers"
import { defineModelStage } from "./stage-factory"

export { assertHasEligibleTimeDomainGraph, assertObserverFoundEligibleTimeDomainGraph }

export const characterizeStage = defineModelStage({
  id: "find_reference_graphs",
  depends_on: ["prepare_workspace"],
  async execute({ context, services, dependency_outputs, signal, debug_dir }) {
    services.model_run_store.startSegment(context.model_run_id)
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "characterizing",
      message: "Finding source reference graphs in the datasheet",
    })

    const model_interface: ModelInterface = parseModelInterface(
      await readJson(join(context.model_dir, "model-interface.json")),
    )
    const application_fixture: ApplicationFixtureContract = parseApplicationFixtureContract(
      await readJson(join(context.model_dir, "application-fixture-contract.json")),
    )
    const attempt_dir = dependency_outputs.prepare_workspace.attempt_dir

    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "characterizing",
      message: "Independently inventorying elapsed-time graphs in the complete datasheet",
    })
    const inventory = await findReferenceGraphs({
      context,
      services,
      attempt_dir,
      debug_dir,
      signal,
      model_interface,
      application_fixture,
    })

    const references = foundObservedGraphs(inventory.observation)
    const evidence_dir = await materializeFoundReferenceEvidence({
      workspace: attempt_dir,
      datasheet_path: join(context.model_dir, "datasheet.pdf"),
      observation: inventory.observation,
      process_runner: services.process_runner,
      signal,
      on_output: (stream, message) =>
        services.model_run_store.appendLog(context.model_run_id, { stream, message }).then(() => undefined),
    })
    const reference_observation_path = join(attempt_dir, "model-reference-observation.json")

    await projectFoundReferencesUi({
      model_run_store: services.model_run_store,
      model_run_id: context.model_run_id,
      model_dir: context.model_dir,
      observation: inventory.observation,
      evidence_dir,
      signal,
    })

    return {
      status: "completed",
      output: {
        found_reference_ids: references.map(({ graph_id }) => graph_id),
        evidence_dir,
        application_fixture_path: join(attempt_dir, "application-fixture-contract.json"),
        application_fixture_sha256: application_fixture.contract_sha256,
        time_graph_hints_path: inventory.time_graph_hints_path,
        reference_observation_path,
      },
      artifacts: [
        await modelArtifact({
          id: "application_fixture_contract",
          path: join(attempt_dir, "application-fixture-contract.json"),
          media_type: "application/json",
          role: "model_contract",
        }),
        await modelArtifact({
          id: "time_graph_hints",
          path: inventory.time_graph_hints_path,
          media_type: "application/json",
          role: "source_observation",
        }),
        await modelArtifact({
          id: "model_reference_observation",
          path: reference_observation_path,
          media_type: "application/json",
          role: "source_observation",
        }),
      ],
      metrics: {
        agent_attempts: inventory.observer_attempts,
        reference_observer_attempts: inventory.observer_attempts,
        found_references: references.length,
        application_fixture_documented: application_fixture.availability === "documented" ? 1 : 0,
      },
    }
  },
})
