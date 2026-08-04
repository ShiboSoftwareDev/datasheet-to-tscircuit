import { createPipelineStageFactory } from "../../pipeline"
import type { ComponentPipelineContext, ComponentPipelineOutputs, ComponentPipelineServices } from "../types"

export const defineComponentStage = createPipelineStageFactory<
  ComponentPipelineOutputs,
  ComponentPipelineContext,
  ComponentPipelineServices
>()
