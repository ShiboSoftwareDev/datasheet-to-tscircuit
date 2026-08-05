import type { PipelineDefinition } from "../pipeline"
import type {
  ApplicationPipelineOutputs,
  ComponentPipelineContext,
  ComponentPipelineOutputs,
  ComponentPipelineServices,
} from "./types"
import { extractEvidenceStage } from "./stages/extract-evidence"
import { generateApplicationStage } from "./stages/generate-application"
import { generateComponentStage } from "./stages/generate-component"
import { prepareStage } from "./stages/prepare"
import { prepareApplicationStage } from "./stages/prepare-application"
import { publishStage } from "./stages/publish"
import { repairApplicationStage } from "./stages/repair-application"
import { repairComponentStage } from "./stages/repair-component"
import { validateApplicationStage } from "./stages/validate-application"
import { validateComponentStage } from "./stages/validate-component"

export const COMPONENT_PIPELINE: PipelineDefinition<
  ComponentPipelineOutputs,
  ComponentPipelineContext,
  ComponentPipelineServices
> = Object.freeze({
  pipeline_id: "component_generation",
  stages: Object.freeze([
    prepareStage,
    extractEvidenceStage,
    generateComponentStage,
    validateComponentStage,
    repairComponentStage,
  ]),
})

export const APPLICATION_PIPELINE: PipelineDefinition<
  ApplicationPipelineOutputs,
  ComponentPipelineContext,
  ComponentPipelineServices
> = Object.freeze({
  pipeline_id: "typical_application",
  stages: Object.freeze([
    prepareApplicationStage,
    generateApplicationStage,
    validateApplicationStage,
    repairApplicationStage,
    publishStage,
  ]),
})
