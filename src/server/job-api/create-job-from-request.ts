import type { Job, ModelRun } from "@/shared/job-types"
import { BunProcessRunner, type ProcessRunner } from "../infrastructure/process"
import { launchModelRun } from "../model-run-api"
import type { JobApiContext } from "./job-api-context"
import { errorResponse, jsonResponse } from "./job-api-responses"
import { launchJobRunner } from "./launch-job-runner"
import { prepareJobWorkspace } from "./prepare-job-workspace"
import { validatePdf } from "./validate-pdf"

async function isOpenAiAuthenticated(agent_bin: string, process_runner: ProcessRunner): Promise<boolean> {
  let output = ""
  try {
    await process_runner.run({
      command: [agent_bin, "auth", "status", "--openai"],
      command_label: "OpenAI authentication check",
      cwd: process.cwd(),
      signal: new AbortController().signal,
      idle_timeout_ms: 2_000,
      wall_timeout_ms: 5_000,
      max_output_chars: 16_000,
      on_output(stream, message) {
        if (stream === "stdout") output = `${output}${message}`.slice(-16_000)
      },
    })
    return output.includes("OpenAI credentials are stored.")
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
  if (
    use_openai &&
    !(await isOpenAiAuthenticated(context.agent_bin, context.process_runner ?? new BunProcessRunner()))
  ) {
    return errorResponse({
      error_code: "openai_auth_required",
      message:
        "OpenAI authentication is missing or invalid. Run this command, then try again:\nbun run auth:openai",
      status: 409,
    })
  }

  const additional_instructions_value = form.get("additional_instructions")
  const additional_instructions =
    typeof additional_instructions_value === "string"
      ? additional_instructions_value.trim().slice(0, 4_000) || undefined
      : undefined

  const job_id = crypto.randomUUID()
  let workspace: Awaited<ReturnType<typeof prepareJobWorkspace>>
  try {
    workspace = await prepareJobWorkspace({
      jobs_root: context.jobs_root,
      job_id,
      write_datasheet: (datasheet_path) => Bun.write(datasheet_path, pdf_bytes),
    })
  } catch (error) {
    return errorResponse({
      error_code: "job_create_failed",
      message: `Task ${job_id} could not be created. ${error instanceof Error ? error.message : String(error)}`,
      status: 500,
    })
  }

  let job: Job
  try {
    job = context.job_store.createJob({
      job_id,
      job_dir: workspace.job_dir,
      file_name: datasheet.name,
      use_openai,
      additional_instructions,
    })
  } catch (error) {
    const workspace_was_removed = await workspace.discard().then(
      () => true,
      () => false,
    )
    return errorResponse({
      error_code: "job_create_failed",
      message: `Task ${job_id} could not be registered: ${error instanceof Error ? error.message : String(error)}${workspace_was_removed ? "" : " The uncommitted workspace could not be removed and will be ignored on restart."}`,
      status: 500,
    })
  }

  await context.job_store
    .appendLog(job_id, {
      stream: "system",
      message: `Uploaded ${datasheet.name} (${datasheet.size} bytes).\n`,
    })
    .catch(() => undefined)
  let model_run: ModelRun | undefined
  if (create_pspice_model && model_effort_multiplier && context.model_run_store) {
    const launch = await launchModelRun(
      { job_id, job_dir: workspace.job_dir, effort_multiplier: model_effort_multiplier },
      { ...context, model_run_store: context.model_run_store, use_openai },
    )
    if (launch.status === "job_deleting") {
      return errorResponse({
        error_code: "job_deleting",
        message: "This task is being deleted; its SPICE model cannot be changed.",
        status: 409,
      })
    }
    if (launch.status === "job_not_found") {
      return errorResponse({
        error_code: "job_not_found",
        message: `No job exists for ${job_id}.`,
        status: 404,
      })
    }
    if (launch.status === "already_exists") {
      return errorResponse({
        error_code: "model_run_exists",
        message: "This job already has a SPICE model run.",
        status: 409,
      })
    }
    model_run = launch.model_run
  }

  launchJobRunner({ job_id, additional_instructions }, { ...context, use_openai })

  return jsonResponse({ job, model_run }, 202)
}
