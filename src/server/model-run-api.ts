import { join } from "node:path"
import type { ApiError, ModelRunEvent } from "@/shared/job-types"
import { listModelPreviewOptions, loadModelSelectedPreview } from "./model-artifact-monitor"
import { runModel, type ModelRunnerContext } from "./model-runner"
import type { ModelRunStore } from "./model-run-store"

export interface ModelRunApiContext extends ModelRunnerContext {
  run_model?: typeof runModel
  model_base_effort_ms?: number
}

function jsonResponse(body: object, status = 200): Response {
  return Response.json(body, { status })
}

function errorResponse(error_code: string, message: string, status: number): Response {
  const api_error: ApiError = { error: { error_code, message } }
  return jsonResponse(api_error, status)
}

function getJobId(request_url: URL): string | undefined {
  return request_url.searchParams.get("job_id")?.trim() || undefined
}

async function readEffort(
  request: Request,
  field: "effort_multiplier" | "additional_effort",
): Promise<number | undefined> {
  const value: unknown = await request.json().catch(() => undefined)
  if (typeof value !== "object" || value === null || !(field in value)) return undefined
  const effort = (value as Record<string, unknown>)[field]
  return typeof effort === "number" && Number.isInteger(effort) && effort >= 1 && effort <= 8
    ? effort
    : undefined
}

function createEventStream(model_run_id: string, model_run_store: ModelRunStore): Response {
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ModelRunEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          unsubscribe?.()
          if (heartbeat) clearInterval(heartbeat)
        }
      }
      const model_run = model_run_store.getModelRun(model_run_id)
      if (model_run) send({ event_type: "snapshot", model_run })
      unsubscribe = model_run_store.subscribe(model_run_id, send)
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"))
        } catch {
          unsubscribe?.()
          if (heartbeat) clearInterval(heartbeat)
        }
      }, 15_000)
    },
    cancel() {
      unsubscribe?.()
      if (heartbeat) clearInterval(heartbeat)
    },
  })
  return new Response(body, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  })
}

export async function launchModelRun(
  input: { job_id: string; job_dir: string; effort_multiplier: number },
  context: ModelRunApiContext,
) {
  const model_run_id = crypto.randomUUID()
  const configured_base_effort_ms =
    context.model_base_effort_ms ?? Number(process.env.MODEL_BASE_EFFORT_MS ?? 30 * 60 * 1000)
  const base_effort_ms =
    Number.isFinite(configured_base_effort_ms) && configured_base_effort_ms > 0
      ? configured_base_effort_ms
      : 30 * 60 * 1000
  context.model_run_store.createModelRun({
    model_run_id,
    job_id: input.job_id,
    model_dir: join(input.job_dir, "spice"),
    effort_multiplier: input.effort_multiplier,
    base_effort_ms,
  })
  await context.model_run_store.appendLog(
    model_run_id,
    "system",
    `Created a ${input.effort_multiplier}× SPICE behavioral-model run validated with ngspice. Setup and component waiting are untimed; effort applies only to refinement.\n`,
  )
  const runner = context.run_model ?? runModel
  void runner({ model_run_id }, context)
  return context.model_run_store.getModelRun(model_run_id)!
}

async function createModelRun(request: Request, context: ModelRunApiContext): Promise<Response> {
  const request_url = new URL(request.url)
  const job_id = getJobId(request_url)
  if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)
  const job = context.job_store.getJob(job_id)
  const job_dir = context.job_store.getJobDir(job_id)
  if (!job || !job_dir) return errorResponse("job_not_found", `No job exists for ${job_id}.`, 404)
  if (context.model_run_store.getModelRunForJob(job_id)) {
    return errorResponse("model_run_exists", "This job already has a SPICE model run.", 409)
  }
  const effort_multiplier = await readEffort(request, "effort_multiplier")
  if (!effort_multiplier) {
    return errorResponse("invalid_effort", "effort_multiplier must be an integer from 1 through 8.", 400)
  }
  const model_run = await launchModelRun({ job_id, job_dir, effort_multiplier }, context)
  return jsonResponse({ model_run }, 202)
}

async function extendModelRun(request: Request, context: ModelRunApiContext): Promise<Response> {
  const job_id = getJobId(new URL(request.url))
  if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)
  const current_run = context.model_run_store.getModelRunForJob(job_id)
  if (!current_run) return errorResponse("model_run_not_found", "This job has no SPICE model run.", 404)
  if (current_run.status === "validating" || current_run.status === "cancelling") {
    return errorResponse("model_run_busy", "Wait for the current model-run phase to finish.", 409)
  }
  const additional_effort = await readEffort(request, "additional_effort")
  if (!additional_effort) {
    return errorResponse("invalid_effort", "additional_effort must be an integer from 1 through 8.", 400)
  }
  const result = context.model_run_store.extendModelRun(current_run.model_run_id, additional_effort)
  await context.model_run_store.appendLog(
    current_run.model_run_id,
    "system",
    `Added ${additional_effort}× effort without changing the workflow or benchmarks.\n`,
  )
  if (result.should_start) {
    const runner = context.run_model ?? runModel
    void runner({ model_run_id: current_run.model_run_id }, context)
  }
  return jsonResponse({ model_run: context.model_run_store.getModelRun(current_run.model_run_id) }, 202)
}

async function retryModelRun(request_url: URL, context: ModelRunApiContext): Promise<Response> {
  const job_id = getJobId(request_url)
  if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)
  const current_run = context.model_run_store.getModelRunForJob(job_id)
  if (!current_run) return errorResponse("model_run_not_found", "This job has no SPICE model run.", 404)
  const result = context.model_run_store.retryModelRun(current_run.model_run_id)
  if (result !== "retried") {
    return errorResponse("model_run_not_failed", "Only a failed SPICE model run can be retried.", 409)
  }
  await context.model_run_store.appendLog(
    current_run.model_run_id,
    "system",
    "Retrying the failed run from its preserved evidence and best model checkpoint.\n",
  )
  const runner = context.run_model ?? runModel
  void runner({ model_run_id: current_run.model_run_id }, context)
  return jsonResponse({ model_run: context.model_run_store.getModelRun(current_run.model_run_id) }, 202)
}

function cancelModelRun(request_url: URL, context: ModelRunApiContext): Response {
  const job_id = getJobId(request_url)
  if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)
  const model_run = context.model_run_store.getModelRunForJob(job_id)
  if (!model_run) return errorResponse("model_run_not_found", "This job has no SPICE model run.", 404)
  const result = context.model_run_store.requestCancellation(model_run.model_run_id)
  if (result === "already_complete") {
    return errorResponse("model_run_complete", "This SPICE model run has already finished.", 409)
  }
  return jsonResponse(
    { model_run: context.model_run_store.getModelRun(model_run.model_run_id) },
    result === "requested" ? 202 : 200,
  )
}

function getModelRunFile(request_url: URL, context: ModelRunApiContext): Response {
  const job_id = getJobId(request_url)
  if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)
  const model_run_id = context.model_run_store.getModelRunIdForJob(job_id)
  const model_dir = model_run_id ? context.model_run_store.getModelDir(model_run_id) : undefined
  if (!model_run_id || !model_dir) {
    return errorResponse("model_run_not_found", "This job has no SPICE model run.", 404)
  }
  const file_kind = request_url.searchParams.get("file")
  const files: Record<string, { name: string; content_type: string }> = {
    model: { name: "model.lib", content_type: "text/plain; charset=utf-8" },
    manifest: { name: "model-manifest.json", content_type: "application/json" },
    report: { name: "validation-report.json", content_type: "application/json" },
    simulation_report: { name: "simulation-validation.json", content_type: "application/json" },
    model_card: { name: "model-card.md", content_type: "text/markdown; charset=utf-8" },
    component: { name: "component-with-model.circuit.tsx", content_type: "text/typescript; charset=utf-8" },
    log: { name: "model-agent.log", content_type: "text/plain; charset=utf-8" },
  }
  const selected = file_kind ? files[file_kind] : undefined
  if (!selected) return errorResponse("invalid_file", "Unknown SPICE model file.", 400)
  const file = Bun.file(join(model_dir, selected.name))
  if (file.size === 0) return errorResponse("file_not_ready", `${selected.name} is not ready.`, 404)
  return new Response(file, {
    headers: {
      "Content-Disposition": `attachment; filename="${selected.name}"`,
      "Content-Type": selected.content_type,
    },
  })
}

async function getSelectedPreview(request_url: URL, context: ModelRunApiContext): Promise<Response> {
  const job_id = getJobId(request_url)
  if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)
  const benchmark_id = request_url.searchParams.get("benchmark_id")?.trim()
  if (!benchmark_id) {
    return errorResponse("benchmark_id_required", "benchmark_id is required.", 400)
  }
  const model_run_id = context.model_run_store.getModelRunIdForJob(job_id)
  const model_dir = model_run_id ? context.model_run_store.getModelDir(model_run_id) : undefined
  if (!model_run_id || !model_dir) {
    return errorResponse("model_run_not_found", "This job has no SPICE model run.", 404)
  }
  const preview = await loadModelSelectedPreview({
    model_dir,
    benchmark_id,
  })
  return preview
    ? jsonResponse(preview)
    : errorResponse("preview_not_found", `No benchmark circuit exists for ${benchmark_id}.`, 404)
}

async function getModelRun(request_url: URL, context: ModelRunApiContext): Promise<Response> {
  const job_id = getJobId(request_url)
  if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)
  let model_run = context.model_run_store.getModelRunForJob(job_id)
  if (!model_run) {
    return errorResponse("model_run_not_found", "This job has no SPICE model run.", 404)
  }
  if (model_run.preview_options.length === 0) {
    const model_dir = context.model_run_store.getModelDir(model_run.model_run_id)
    if (model_dir) {
      const preview_options = await listModelPreviewOptions(model_dir)
      if (preview_options.length > 0) {
        model_run = context.model_run_store.updatePreviewOptions(model_run.model_run_id, preview_options)
      }
    }
  }
  return jsonResponse({ model_run })
}

export function createModelRunApiHandler(context: ModelRunApiContext) {
  return async (request: Request): Promise<Response | undefined> => {
    const request_url = new URL(request.url)
    if (!request_url.pathname.startsWith("/api/model-run/")) return undefined
    if (request.method === "OPTIONS") return new Response(null, { status: 204 })
    if (request_url.pathname === "/api/model-run/create" && request.method === "POST") {
      return createModelRun(request, context)
    }
    if (request_url.pathname === "/api/model-run/extend" && request.method === "POST") {
      return extendModelRun(request, context)
    }
    if (request_url.pathname === "/api/model-run/cancel" && request.method === "POST") {
      return cancelModelRun(request_url, context)
    }
    if (request_url.pathname === "/api/model-run/retry" && request.method === "POST") {
      return retryModelRun(request_url, context)
    }
    if (request_url.pathname === "/api/model-run/get" && request.method === "GET") {
      return getModelRun(request_url, context)
    }
    if (request_url.pathname === "/api/model-run/preview" && request.method === "GET") {
      return getSelectedPreview(request_url, context)
    }
    if (request_url.pathname === "/api/model-run/events" && request.method === "GET") {
      const job_id = getJobId(request_url)
      if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)
      const model_run_id = context.model_run_store.getModelRunIdForJob(job_id)
      return model_run_id
        ? createEventStream(model_run_id, context.model_run_store)
        : errorResponse("model_run_not_found", "This job has no SPICE model run.", 404)
    }
    if (request_url.pathname === "/api/model-run/file" && request.method === "GET") {
      return getModelRunFile(request_url, context)
    }
    return errorResponse("route_not_found", "Model-run API route not found.", 404)
  }
}
