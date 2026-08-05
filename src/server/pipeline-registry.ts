import { APPLICATION_PIPELINE, COMPONENT_PIPELINE } from "./component-workflow"
import { MODEL_PIPELINE } from "./model-workflow"

export const PIPELINE_REGISTRY = Object.freeze({
  component_generation: COMPONENT_PIPELINE,
  typical_application: APPLICATION_PIPELINE,
  spice_generation: MODEL_PIPELINE,
})

export type RegisteredPipelineId = keyof typeof PIPELINE_REGISTRY

export function isRegisteredPipelineId(value: string): value is RegisteredPipelineId {
  return value in PIPELINE_REGISTRY
}

export function getRegisteredPipeline(pipelineId: string) {
  if (!isRegisteredPipelineId(pipelineId)) {
    throw new Error(
      `Unknown pipeline ${pipelineId}. Expected one of: ${Object.keys(PIPELINE_REGISTRY).join(", ")}`,
    )
  }
  return PIPELINE_REGISTRY[pipelineId]
}

export const PIPELINE_TASK_CATALOG = Object.freeze(
  Object.entries(PIPELINE_REGISTRY).map(([pipelineId, definition]) => ({
    pipeline_id: pipelineId as RegisteredPipelineId,
    tasks: Object.freeze(
      definition.stages.map(({ id, depends_on: dependsOn }) => ({ id, depends_on: [...dependsOn] })),
    ),
  })),
)
