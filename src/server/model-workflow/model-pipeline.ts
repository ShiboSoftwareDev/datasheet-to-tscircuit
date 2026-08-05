import type { PipelineDefinition } from "../pipeline"
import type { ModelPipelineContext, ModelPipelineOutputs, ModelPipelineServices } from "./types"
import { characterizeStage } from "./stages/characterize"
import { compareSimulationOutputsStage } from "./stages/compare-simulation-outputs"
import { createSimulationTsxStage } from "./stages/create-simulation-tsx"
import { designValidationStage } from "./stages/design-validation"
import { generateModelStage } from "./stages/generate-model"
import { prepareWorkspaceStage } from "./stages/prepare-workspace"
import { publishModelStage } from "./stages/publish-model"
import { repairModelStage } from "./stages/repair-model"
import { runSimulationsStage } from "./stages/validate-model"
import { waitForComponentStage } from "./stages/wait-for-component"

/** The only authoritative model stage order. */
export const MODEL_PIPELINE: PipelineDefinition<
  ModelPipelineOutputs,
  ModelPipelineContext,
  ModelPipelineServices
> = Object.freeze({
  pipeline_id: "spice_generation",
  stages: Object.freeze([
    waitForComponentStage,
    prepareWorkspaceStage,
    characterizeStage,
    designValidationStage,
    generateModelStage,
    createSimulationTsxStage,
    runSimulationsStage,
    compareSimulationOutputsStage,
    repairModelStage,
    publishModelStage,
  ]),
})
