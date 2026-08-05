import { createPipelineStageFactory } from "../../pipeline"
import type {
  ApplicationPipelineOutputs,
  ComponentPipelineContext,
  ComponentPipelineOutputs,
  ComponentPipelineServices,
} from "../types"

export const defineComponentStage = createPipelineStageFactory<
  ComponentPipelineOutputs,
  ComponentPipelineContext,
  ComponentPipelineServices
>()

export const defineApplicationStage = createPipelineStageFactory<
  ApplicationPipelineOutputs,
  ComponentPipelineContext,
  ComponentPipelineServices
>()
