import { copyFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { ApiError, JobEvent, JobListEvent } from "@/shared/job-types"
import { writeJobScaffold } from "./job-scaffold"
import { runJob, type JobRunnerContext } from "./job-runner"
import type { JobStore } from "./job-store"
import { launchModelRun } from "./model-run-api"
import { runModel } from "./model-runner"
import type { ModelRunStore } from "./model-run-store"

const MAX_PDF_BYTES = 30 * 1024 * 1024

export interface JobApiContext extends JobRunnerContext {
  jobs_root: string
  run_job?: typeof runJob
  model_run_store?: ModelRunStore
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

export function validatePdf(file: File, pdf_bytes: Uint8Array): string | undefined {
  if (file.size === 0) return "The selected PDF is empty."
  if (file.size > MAX_PDF_BYTES) return "Datasheets must be 30 MB or smaller."
  if (!file.name.toLowerCase().endsWith(".pdf")) return "Upload a PDF datasheet."
  if (new TextDecoder().decode(pdf_bytes.slice(0, 5)) !== "%PDF-")
    return "The selected file is not a valid PDF."
  return undefined
}

function createEventStream(job_id: string, job_store: JobStore): Response {
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (job_event: JobEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(job_event)}\n\n`))
        } catch {
          unsubscribe?.()
          if (heartbeat) clearInterval(heartbeat)
        }
      }

      const job = job_store.getJob(job_id)
      if (job) send({ event_type: "snapshot", job })
      unsubscribe = job_store.subscribe(job_id, send)
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

function createJobListEventStream(job_store: JobStore): Response {
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (job_event: JobListEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(job_event)}\n\n`))
        } catch {
          unsubscribe?.()
          if (heartbeat) clearInterval(heartbeat)
        }
      }

      send({ event_type: "jobs_snapshot", jobs: job_store.listJobs() })
      unsubscribe = job_store.subscribeToJobList(send)
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

async function createJobFromRequest(request: Request, context: JobApiContext): Promise<Response> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return errorResponse("invalid_form", "Expected a multipart form upload.", 400)
  }

  const datasheet = form.get("datasheet")
  if (!(datasheet instanceof File)) {
    return errorResponse("datasheet_required", "Select a PDF datasheet to continue.", 400)
  }

  const pdf_bytes = new Uint8Array(await datasheet.arrayBuffer())
  const validation_message = validatePdf(datasheet, pdf_bytes)
  if (validation_message) return errorResponse("invalid_datasheet", validation_message, 400)

  const create_pspice_model = form.get("create_pspice_model") === "true"
  const effort_value = Number(form.get("model_effort_multiplier") ?? 1)
  const model_effort_multiplier =
    Number.isInteger(effort_value) && effort_value >= 1 && effort_value <= 8 ? effort_value : undefined
  if (create_pspice_model && !model_effort_multiplier) {
    return errorResponse(
      "invalid_model_effort",
      "model_effort_multiplier must be an integer from 1 through 8.",
      400,
    )
  }
  if (create_pspice_model && !context.model_run_store) {
    return errorResponse("model_runner_unavailable", "SPICE model generation is unavailable.", 503)
  }

  const job_id = crypto.randomUUID()
  const job_dir = join(context.jobs_root, job_id)
  await mkdir(job_dir, { recursive: true })
  await writeJobScaffold(job_dir)
  await Bun.write(join(job_dir, "datasheet.pdf"), pdf_bytes)

  const additional_instructions_value = form.get("additional_instructions")
  const additional_instructions =
    typeof additional_instructions_value === "string"
      ? additional_instructions_value.trim().slice(0, 4_000) || undefined
      : undefined
  const job = context.job_store.createJob({
    job_id,
    job_dir,
    file_name: datasheet.name,
    additional_instructions,
  })
  await context.job_store.appendLog(
    job_id,
    "system",
    `Uploaded ${datasheet.name} (${datasheet.size} bytes).\n`,
  )

  let model_run
  if (create_pspice_model) {
    model_run = await launchModelRun(
      { job_id, job_dir, effort_multiplier: model_effort_multiplier! },
      { ...context, model_run_store: context.model_run_store! },
    )
  }

  const runner = context.run_job ?? runJob
  void runner(
    {
      job_id,
      additional_instructions,
    },
    context,
  )

  return jsonResponse({ job, model_run }, 202)
}

async function retryJob(request_url: URL, context: JobApiContext): Promise<Response> {
  const source_job_id = getJobId(request_url)
  if (!source_job_id) return errorResponse("job_id_required", "job_id is required.", 400)

  const source = context.job_store.getJobRetrySource(source_job_id)
  if (!source) return errorResponse("job_not_found", `No job exists for ${source_job_id}.`, 404)
  if (source.display_status !== "cancelled" && source.display_status !== "failed") {
    return errorResponse("job_not_retryable", "Only stopped or failed tasks can be retried.", 409)
  }

  const job_id = crypto.randomUUID()
  const job_dir = join(context.jobs_root, job_id)
  await mkdir(job_dir, { recursive: true })
  await writeJobScaffold(job_dir)
  await copyFile(join(source.job_dir, "datasheet.pdf"), join(job_dir, "datasheet.pdf"))

  const job = context.job_store.createJob({
    job_id,
    job_dir,
    file_name: source.file_name,
    additional_instructions: source.additional_instructions,
  })
  await context.job_store.appendLog(
    job_id,
    "system",
    `Retrying ${source.display_status} task ${source_job_id}.\n`,
  )

  const runner = context.run_job ?? runJob
  void runner({ job_id, additional_instructions: source.additional_instructions }, context)
  return jsonResponse({ job }, 202)
}

function waitForJobCompletion(job_id: string, job_store: JobStore, timeout_ms = 5_000): Promise<boolean> {
  if (job_store.getJob(job_id)?.is_complete) return Promise.resolve(true)

  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined
    const finish = (is_complete: boolean) => {
      clearTimeout(timeout)
      unsubscribe?.()
      resolve(is_complete)
    }
    const timeout = setTimeout(() => finish(false), timeout_ms)
    unsubscribe = job_store.subscribe(job_id, (job_event) => {
      if (job_event.event_type !== "log" && job_event.job.is_complete) finish(true)
    })
    if (!unsubscribe) finish(false)
  })
}

function waitForModelRunCompletion(
  model_run_id: string,
  model_run_store: ModelRunStore,
  timeout_ms = 5_000,
): Promise<boolean> {
  if (model_run_store.getModelRun(model_run_id)?.is_complete) return Promise.resolve(true)

  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined
    const finish = (is_complete: boolean) => {
      clearTimeout(timeout)
      unsubscribe?.()
      resolve(is_complete)
    }
    const timeout = setTimeout(() => finish(false), timeout_ms)
    unsubscribe = model_run_store.subscribe(model_run_id, (event) => {
      if (event.event_type !== "log" && event.model_run.is_complete) finish(true)
    })
    if (!unsubscribe) finish(false)
  })
}

async function deleteJob(request_url: URL, context: JobApiContext): Promise<Response> {
  const job_id = getJobId(request_url)
  if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)

  const job_dir = context.job_store.getJobDir(job_id)
  const job = context.job_store.getJob(job_id)
  if (!job_dir || !job) return errorResponse("job_not_found", `No job exists for ${job_id}.`, 404)

  const model_run = context.model_run_store?.getModelRunForJob(job_id)
  if (model_run && !model_run.is_complete) {
    context.model_run_store?.requestCancellation(model_run.model_run_id)
    if (!(await waitForModelRunCompletion(model_run.model_run_id, context.model_run_store!))) {
      return errorResponse("model_stop_timeout", "The SPICE model run could not be stopped.", 409)
    }
  }

  if (!job.is_complete) {
    context.job_store.requestCancellation(job_id)
    if (!(await waitForJobCompletion(job_id, context.job_store))) {
      return errorResponse("job_stop_timeout", "The task could not be stopped before deletion.", 409)
    }
  }

  if (!context.job_store.deleteJob(job_id)) {
    return errorResponse("job_delete_conflict", "The task is still active and cannot be deleted.", 409)
  }
  context.model_run_store?.deleteModelRunForJob(job_id)
  await rm(job_dir, { recursive: true, force: true })
  return new Response(null, { status: 204 })
}

function cancelJob(request_url: URL, context: JobApiContext): Response {
  const job_id = getJobId(request_url)
  if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)

  const cancellation_result = context.job_store.requestCancellation(job_id)
  if (cancellation_result === "not_found") {
    return errorResponse("job_not_found", `No job exists for ${job_id}.`, 404)
  }
  if (cancellation_result === "already_complete") {
    return errorResponse("job_already_complete", "This job has already finished.", 409)
  }

  const job = context.job_store.getJob(job_id)
  if (!job) return errorResponse("job_not_found", `No job exists for ${job_id}.`, 404)
  return jsonResponse({ job }, cancellation_result === "requested" ? 202 : 200)
}

function getJobFile(request_url: URL, context: JobApiContext): Response {
  const job_id = getJobId(request_url)
  const file_kind = request_url.searchParams.get("file")
  if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)
  const job_dir = context.job_store.getJobDir(job_id)
  if (!job_dir) return errorResponse("job_not_found", `No job exists for ${job_id}.`, 404)

  if (file_kind === "component") {
    return new Response(Bun.file(join(job_dir, "index.circuit.tsx")), {
      headers: {
        "Content-Disposition": 'attachment; filename="index.circuit.tsx"',
        "Content-Type": "text/typescript; charset=utf-8",
      },
    })
  }
  if (file_kind === "typical_application") {
    return new Response(Bun.file(join(job_dir, "typical-application.circuit.tsx")), {
      headers: {
        "Content-Disposition": 'attachment; filename="typical-application.circuit.tsx"',
        "Content-Type": "text/typescript; charset=utf-8",
      },
    })
  }
  if (file_kind === "log") {
    return new Response(Bun.file(join(job_dir, "agent.log")), {
      headers: {
        "Content-Disposition": 'attachment; filename="agent.log"',
        "Content-Type": "text/plain; charset=utf-8",
      },
    })
  }
  return errorResponse("invalid_file", "file must be component, typical_application, or log.", 400)
}

export function createJobApiHandler(context: JobApiContext) {
  return async (request: Request): Promise<Response | undefined> => {
    const request_url = new URL(request.url)
    if (!request_url.pathname.startsWith("/api/")) return undefined

    if (request.method === "OPTIONS") return new Response(null, { status: 204 })
    if (request_url.pathname === "/api/job/create" && request.method === "POST") {
      return createJobFromRequest(request, context)
    }
    if (request_url.pathname === "/api/jobs" && request.method === "GET") {
      return jsonResponse({ jobs: context.job_store.listJobs() })
    }
    if (request_url.pathname === "/api/jobs/events" && request.method === "GET") {
      return createJobListEventStream(context.job_store)
    }
    if (request_url.pathname === "/api/job/cancel" && request.method === "POST") {
      return cancelJob(request_url, context)
    }
    if (request_url.pathname === "/api/job/retry" && request.method === "POST") {
      return retryJob(request_url, context)
    }
    if (request_url.pathname === "/api/job/delete" && request.method === "DELETE") {
      return deleteJob(request_url, context)
    }
    if (request_url.pathname === "/api/job/get" && request.method === "GET") {
      const job_id = getJobId(request_url)
      if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)
      const job = context.job_store.getJob(job_id)
      return job ? jsonResponse({ job }) : errorResponse("job_not_found", `No job exists for ${job_id}.`, 404)
    }
    if (request_url.pathname === "/api/job/events" && request.method === "GET") {
      const job_id = getJobId(request_url)
      if (!job_id) return errorResponse("job_id_required", "job_id is required.", 400)
      if (!context.job_store.getJob(job_id)) {
        return errorResponse("job_not_found", `No job exists for ${job_id}.`, 404)
      }
      return createEventStream(job_id, context.job_store)
    }
    if (request_url.pathname === "/api/job/file" && request.method === "GET") {
      return getJobFile(request_url, context)
    }
    return errorResponse("route_not_found", "API route not found.", 404)
  }
}
