import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { writeJobScaffold } from "../job-scaffold"
import { launchModelRun } from "../model-run-api"
import { JobApiContext } from "./job-api-context"
import { errorResponse, jsonResponse } from "./job-api-responses"
import { validatePdf } from "./validate-pdf"
import { launchJobRunner } from "./launch-job-runner"

async function isOpenAiAuthenticated(agent_bin: string): Promise<boolean> {
  try {
    const child = Bun.spawn([agent_bin, "auth", "status", "--openai"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const [exit_code, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
    return exit_code === 0 && output.includes("OpenAI credentials are stored.")
  } catch {
    return false
  }
}

export async function createJobFromRequest(request: Request, context: JobApiContext): Promise<Response> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return errorResponse({
      error_code: "invalid_form",
      message: "Expected a multipart form upload.",
      status: 400,
    })
  }

  const datasheet = form.get("datasheet")
  if (!(datasheet instanceof File)) {
    return errorResponse({
      error_code: "datasheet_required",
      message: "Select a PDF datasheet to continue.",
      status: 400,
    })
  }

  const pdf_bytes = new Uint8Array(await datasheet.arrayBuffer())
  const validation_message = validatePdf(datasheet, pdf_bytes)
  if (validation_message) {
    return errorResponse({ error_code: "invalid_datasheet", message: validation_message, status: 400 })
  }

  const create_pspice_model = form.get("create_pspice_model") === "true"
  const effort_value = Number(form.get("model_effort_multiplier") ?? 1)
  const model_effort_multiplier =
    Number.isInteger(effort_value) && effort_value >= 1 && effort_value <= 8 ? effort_value : undefined
  if (create_pspice_model && !model_effort_multiplier) {
    return errorResponse({
      error_code: "invalid_model_effort",
      message: "model_effort_multiplier must be an integer from 1 through 8.",
      status: 400,
    })
  }
  if (create_pspice_model && !context.model_run_store) {
    return errorResponse({
      error_code: "model_runner_unavailable",
      message: "SPICE model generation is unavailable.",
      status: 503,
    })
  }

  const use_openai = form.get("use_openai") === "true"
  if (use_openai && !(await isOpenAiAuthenticated(context.agent_bin))) {
    return errorResponse({
      error_code: "openai_auth_required",
      message:
        "OpenAI authentication is missing or invalid. Run this command, then try again:\nbun run auth:openai",
      status: 409,
    })
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
  await context.job_store.appendLog(job_id, {
    stream: "system",
    message: `Uploaded ${datasheet.name} (${datasheet.size} bytes).\n`,
  })
  let model_run
  if (create_pspice_model) {
    model_run = await launchModelRun(
      { job_id, job_dir, effort_multiplier: model_effort_multiplier! },
      { ...context, model_run_store: context.model_run_store!, use_openai },
    )
  }

  launchJobRunner({ job_id, additional_instructions }, { ...context, use_openai })

  return jsonResponse({ job, model_run }, 202)
}
