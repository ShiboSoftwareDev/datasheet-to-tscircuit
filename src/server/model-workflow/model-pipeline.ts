import type { PipelineDefinition } from "../pipeline"
import type { ModelPipelineContext, ModelPipelineOutputs, ModelPipelineServices } from "./types"
import { characterizeStage } from "./stages/characterize"
import { designValidationStage } from "./stages/design-validation"
import { generateModelStage } from "./stages/generate-model"
import { prepareWorkspaceStage } from "./stages/prepare-workspace"
import { publishModelStage } from "./stages/publish-model"
import { repairModelStage } from "./stages/repair-model"
import { validateModelStage } from "./stages/validate-model"
import { waitForComponentStage } from "./stages/wait-for-component"

/** The only authoritative model stage order. */
export const MODEL_PIPELINE: PipelineDefinition<
  ModelPipelineOutputs,
  ModelPipelineContext,
  ModelPipelineServices
> = Object.freeze({
  pipeline_id: "datasheet_model",
  stages: Object.freeze([
    waitForComponentStage,
    prepareWorkspaceStage,
    characterizeStage,
    designValidationStage,
    generateModelStage,
    validateModelStage,
    repairModelStage,
    publishModelStage,
  ]),
})
