import type { PipelineDefinition } from "../pipeline"
import type {
  ApplicationPipelineOutputs,
  ComponentPipelineContext,
  ComponentPipelineOutputs,
  ComponentPipelineServices,
} from "./types"
import { extractEvidenceStage } from "./stages/extract-evidence"
import { buildApplicationStage } from "./stages/build-application"
import { buildComponentStage } from "./stages/build-component"
import { extractApplicationEvidenceStage } from "./stages/extract-application-evidence"
import { generateApplicationStage } from "./stages/generate-application"
import { generateComponentStage } from "./stages/generate-component"
import { publishStage } from "./stages/publish"
import { planApplicationsStage } from "./stages/plan-applications"
import { publishComponentStage } from "./stages/publish-component"
import { repairApplicationStage } from "./stages/repair-application"
import { repairComponentStage } from "./stages/repair-component"
import { validateApplicationStage } from "./stages/validate-application"
import { validateComponentStage } from "./stages/validate-component"
import { waitForComponentStage } from "./stages/wait-for-component"

export const COMPONENT_PIPELINE: PipelineDefinition<
  ComponentPipelineOutputs,
  ComponentPipelineContext,
  ComponentPipelineServices
> = Object.freeze({
  pipeline_id: "component_generation",
  stages: Object.freeze([
    extractEvidenceStage,
    generateComponentStage,
    buildComponentStage,
    validateComponentStage,
    repairComponentStage,
    publishComponentStage,
  ]),
})

export const APPLICATION_PIPELINE: PipelineDefinition<
  ApplicationPipelineOutputs,
  ComponentPipelineContext,
  ComponentPipelineServices
> = Object.freeze({
  pipeline_id: "typical_application",
  stages: Object.freeze([
    extractApplicationEvidenceStage,
    waitForComponentStage,
    planApplicationsStage,
    generateApplicationStage,
    buildApplicationStage,
    validateApplicationStage,
    repairApplicationStage,
    publishStage,
  ]),
})
