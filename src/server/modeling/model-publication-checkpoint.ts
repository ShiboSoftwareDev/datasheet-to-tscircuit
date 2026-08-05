import { parsePublicPipelineSnapshot } from "../pipeline/public-snapshot"

/**
 * A completed publish_model stage crossed the model publication commit barrier.
 * Its persisted checkpoint therefore requires published-model.json to exist;
 * legacy root files are not an authoritative fallback when that pointer is gone.
 */
export function modelCheckpointRequiresPublicationPointer(
  checkpoint: { readonly pipeline?: unknown } | undefined,
): boolean {
  const pipeline = parsePublicPipelineSnapshot(checkpoint?.pipeline)
  return Boolean(
    (pipeline?.pipeline_id === "spice_generation" || pipeline?.pipeline_id === "datasheet_model") &&
      pipeline.status === "completed" &&
      (pipeline.stage_results.publish?.status === "completed" ||
        pipeline.stage_results.publish_model?.status === "completed"),
  )
}
