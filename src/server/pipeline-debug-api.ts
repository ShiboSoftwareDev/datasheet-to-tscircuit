import type { PublicPipelineSnapshot } from "@/shared/job-types"
import { PIPELINE_DEBUG_CATALOG } from "@/shared/pipeline-debug"

export function mergeDebugSnapshot(
  previous: PublicPipelineSnapshot | undefined,
  current: PublicPipelineSnapshot,
  selected_stage_ids: ReadonlySet<string>,
): PublicPipelineSnapshot {
  if (!previous) return current
  return {
    ...current,
    stage_results: Object.fromEntries(
      Object.entries(current.stage_results).map(([stage_id, stage]) => [
        stage_id,
        selected_stage_ids.has(stage_id) ? stage : (previous.stage_results[stage_id] ?? stage),
      ]),
    ),
  }
}

function localOnlyResponse(): Response {
  return Response.json(
    {
      error: {
        error_code: "local_run_required",
        message: "Pipeline debugging now creates an isolated Local run. Use /api/local-run/run.",
      },
    },
    { status: 410 },
  )
}

export function createPipelineDebugApiHandler(_context: unknown) {
  return async (request: Request): Promise<Response | undefined> => {
    const requestUrl = new URL(request.url)
    if (requestUrl.pathname === "/api/pipeline/catalog" && request.method === "GET") {
      return Response.json({ pipelines: PIPELINE_DEBUG_CATALOG })
    }
    if (requestUrl.pathname === "/api/pipeline/debug-run") return localOnlyResponse()
    return undefined
  }
}
