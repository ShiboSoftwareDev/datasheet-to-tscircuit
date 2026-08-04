import { createPipelineStageFactory } from "../../pipeline"
import type { ModelPipelineContext, ModelPipelineOutputs, ModelPipelineServices } from "../types"

export const defineModelStage = createPipelineStageFactory<
  ModelPipelineOutputs,
  ModelPipelineContext,
  ModelPipelineServices
>()
