import type { PipelineDefinition } from "../pipeline"
import type { ComponentPipelineContext, ComponentPipelineOutputs, ComponentPipelineServices } from "./types"
import { extractEvidenceStage } from "./stages/extract-evidence"
import { generateApplicationStage } from "./stages/generate-application"
import { generateComponentStage } from "./stages/generate-component"
import { prepareStage } from "./stages/prepare"
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
  pipeline_id: "datasheet_component",
  stages: Object.freeze([
    prepareStage,
    extractEvidenceStage,
    generateComponentStage,
    validateComponentStage,
    repairComponentStage,
    generateApplicationStage,
    validateApplicationStage,
    repairApplicationStage,
    publishStage,
  ]),
})
