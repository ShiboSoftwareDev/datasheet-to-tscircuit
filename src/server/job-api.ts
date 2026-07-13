import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { ApiError, JobEvent } from "@/shared/job-types"
import { writeJobScaffold } from "./job-scaffold"
import { runJob, type JobRunnerContext } from "./job-runner"
import type { JobStore } from "./job-store"

const MAX_PDF_BYTES = 30 * 1024 * 1024

export interface JobApiContext extends JobRunnerContext {
  jobs_root: string
  run_job?: typeof runJob
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

  const job_id = crypto.randomUUID()
  const job_dir = join(context.jobs_root, job_id)
  await mkdir(job_dir, { recursive: true })
  await writeJobScaffold(job_dir)
  await Bun.write(join(job_dir, "datasheet.pdf"), pdf_bytes)

  const job = context.job_store.createJob({ job_id, job_dir, file_name: datasheet.name })
  await context.job_store.appendLog(
    job_id,
    "system",
    `Uploaded ${datasheet.name} (${datasheet.size} bytes).\n`,
  )

  const additional_instructions = form.get("additional_instructions")
  const runner = context.run_job ?? runJob
  void runner(
    {
      job_id,
      additional_instructions:
        typeof additional_instructions === "string" ? additional_instructions.slice(0, 4_000) : undefined,
    },
    context,
  )

  return jsonResponse({ job }, 202)
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
  if (file_kind === "log") {
    return new Response(Bun.file(join(job_dir, "agent.log")), {
      headers: {
        "Content-Disposition": 'attachment; filename="agent.log"',
        "Content-Type": "text/plain; charset=utf-8",
      },
    })
  }
  return errorResponse("invalid_file", "file must be component or log.", 400)
}

export function createJobApiHandler(context: JobApiContext) {
  return async (request: Request): Promise<Response | undefined> => {
    const request_url = new URL(request.url)
    if (!request_url.pathname.startsWith("/api/")) return undefined

    if (request.method === "OPTIONS") return new Response(null, { status: 204 })
    if (request_url.pathname === "/api/job/create" && request.method === "POST") {
      return createJobFromRequest(request, context)
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
