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
import { runCharacterizer } from "../characterization/run-characterizer"
import { inventoryReferenceGraphs } from "../characterization/source-inventory"
import { modelArtifact, readJson, updateModelProgress } from "../stage-helpers"
import { defineModelStage } from "./stage-factory"

export { assertHasEligibleTimeDomainGraph, assertObserverFoundEligibleTimeDomainGraph }

export const characterizeStage = defineModelStage({
  id: "characterize",
  depends_on: ["prepare_workspace"],
  async execute({ context, services, dependency_outputs, signal, debug_dir }) {
    services.model_run_store.startSegment(context.model_run_id)
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "characterizing",
      message: "Extracting model requirements and reference curves from the datasheet",
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
    const inventory = await inventoryReferenceGraphs({
      context,
      services,
      attempt_dir,
      debug_dir,
      signal,
      model_interface,
      application_fixture,
    })

    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "characterizing",
      message: "Extracting model requirements and verified reference curves from the datasheet",
    })
    const result = await runCharacterizer({
      context,
      services,
      attempt_dir,
      debug_dir,
      signal,
      model_interface,
      application_fixture,
      time_graph_hints_path: inventory.time_graph_hints_path,
      source_observation: inventory.observation,
      source_proof: inventory.source_proof,
    })

    const { characterization } = result
    const modeled_requirement_ids = characterization.requirements.flatMap(({ requirement_id, support }) =>
      support.status === "modeled" ? [requirement_id] : [],
    )
    const contract_path = join(attempt_dir, "model-contract.json")
    const reference_observation_path = join(attempt_dir, "model-reference-observation.json")
    const reference_source_proof_path = join(attempt_dir, "model-reference-source-proof.json")
    const reference_verification_path = join(attempt_dir, "model-reference-verification.json")

    return {
      status: "completed",
      output: {
        contract_path,
        family: characterization.family,
        strategy: characterization.strategy,
        modeled_requirement_ids,
        documented_only_count: characterization.requirements.length - modeled_requirement_ids.length,
        application_fixture_path: join(attempt_dir, "application-fixture-contract.json"),
        application_fixture_sha256: application_fixture.contract_sha256,
        time_graph_hints_path: inventory.time_graph_hints_path,
        reference_observation_path,
        reference_source_proof_path,
        reference_verification_path,
      },
      artifacts: [
        await modelArtifact({
          id: "model_contract",
          path: contract_path,
          media_type: "application/json",
          role: "model_contract",
        }),
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
        await modelArtifact({
          id: "model_reference_source_proof",
          path: reference_source_proof_path,
          media_type: "application/json",
          role: "source_verification",
        }),
        await modelArtifact({
          id: "model_reference_verification",
          path: reference_verification_path,
          media_type: "application/json",
          role: "source_verification",
        }),
      ],
      metrics: {
        agent_attempts: result.attempts,
        reference_observer_attempts: inventory.observer_attempts,
        reference_observer_reused: inventory.reused_from_invocation_id ? 1 : 0,
        modeled_requirements: modeled_requirement_ids.length,
        documented_only_requirements: characterization.requirements.length - modeled_requirement_ids.length,
        application_fixture_documented: application_fixture.availability === "documented" ? 1 : 0,
      },
    }
  },
})
