import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { PublicPipelineSnapshot } from "@/shared/job-types"
import { TsciAgentClient } from "../infrastructure/agent"
import { BunProcessRunner } from "../infrastructure/process"
import { projectPublicPipelineSnapshot, runPipeline } from "../pipeline"
import { APPLICATION_PIPELINE, COMPONENT_PIPELINE } from "./component-pipeline"
import { appendJobLog } from "./stage-helpers"
import type { ComponentPipelineServices, JobRunnerContext } from "./types"

function failureMessage(result: PublicPipelineSnapshot): string {
  for (const stage of Object.values(result.stage_results)) {
    if (stage.status === "failed" && stage.error) {
      return `[${stage.stage_id}/${stage.error.code}] ${stage.error.message}\nTrace: ${stage.debug_ref}`
    }
  }
  return "Component pipeline failed without a stage diagnostic."
}

export async function runJob(
  input: { job_id: string; additional_instructions?: string },
  context: JobRunnerContext,
): Promise<void> {
  const job_dir = context.job_store.getJobDir(input.job_id)
  const signal = context.job_store.getCancellationSignal(input.job_id)
  const job = context.job_store.getJob(input.job_id)
  if (!job_dir || !signal || !job) throw new Error(`Job ${input.job_id} was not found`)
  const process_runner = context.process_runner ?? new BunProcessRunner()
  const agent_client =
    context.agent_client ??
    new TsciAgentClient({
      process_runner,
      agent_bin: context.agent_bin,
      max_attempts: context.agent_transport_retry_limit,
      retry_base_delay_ms: context.agent_transport_retry_base_delay_ms,
    })
  const services: ComponentPipelineServices = {
    job_store: context.job_store,
    agent_client,
    process_runner,
    tsci_bin: context.tsci_bin,
  }
  try {
    const component_invocation_id = crypto.randomUUID()
    const component_invocation_dir = join(
      job_dir,
      "runs",
      COMPONENT_PIPELINE.pipeline_id,
      component_invocation_id,
    )
    await mkdir(component_invocation_dir, { recursive: true })
    const component_result = await runPipeline({
      definition: COMPONENT_PIPELINE,
      run_id: input.job_id,
      workspace_dir: component_invocation_dir,
      context: {
        job_id: input.job_id,
        job_dir,
        additional_instructions: input.additional_instructions,
        use_openai: job.use_openai ?? context.use_openai ?? false,
        invocation_id: component_invocation_id,
      },
      services,
      signal,
      on_snapshot: (snapshot) => {
        const projected = projectPublicPipelineSnapshot({
          snapshot,
          artifact_root: job_dir,
          private_roots: [component_invocation_dir],
        })
        const pipelines = context.job_store.getJob(input.job_id)?.pipelines ?? {}
        context.job_store.updateJob(input.job_id, {
          pipeline: projected,
          pipelines: { ...pipelines, component_generation: projected },
        })
      },
    })
    const public_component_result = projectPublicPipelineSnapshot({
      snapshot: component_result,
      artifact_root: job_dir,
      private_roots: [component_invocation_dir],
    })
    if (component_result.status === "cancelled" || signal.aborted) {
      await appendJobLog(
        context.job_store,
        input.job_id,
        "system",
        "Component pipeline was cancelled.\n",
      ).catch(() => undefined)
      context.job_store.updateJob(input.job_id, {
        display_status: "cancelled",
        is_complete: true,
        has_errors: false,
        error_message: undefined,
        completed_at: new Date().toISOString(),
        pipeline: public_component_result,
      })
      return
    }
    if (component_result.status === "failed") {
      const error_message = failureMessage(public_component_result)
      await appendJobLog(
        context.job_store,
        input.job_id,
        "system",
        `Component pipeline failed: ${error_message}\n`,
      ).catch(() => undefined)
      context.job_store.updateJob(input.job_id, {
        display_status: "failed",
        is_complete: true,
        has_errors: true,
        error_message,
        completed_at: new Date().toISOString(),
        pipeline: public_component_result,
      })
      return
    }

    const application_invocation_id = crypto.randomUUID()
    const application_invocation_dir = join(
      job_dir,
      "runs",
      APPLICATION_PIPELINE.pipeline_id,
      application_invocation_id,
    )
    await mkdir(application_invocation_dir, { recursive: true })
    const application_result = await runPipeline({
      definition: APPLICATION_PIPELINE,
      run_id: input.job_id,
      workspace_dir: application_invocation_dir,
      context: {
        job_id: input.job_id,
        job_dir,
        additional_instructions: input.additional_instructions,
        use_openai: job.use_openai ?? context.use_openai ?? false,
        invocation_id: application_invocation_id,
      },
      services,
      signal,
      on_snapshot: (snapshot) => {
        const projected = projectPublicPipelineSnapshot({
          snapshot,
          artifact_root: job_dir,
          private_roots: [application_invocation_dir],
        })
        const pipelines = context.job_store.getJob(input.job_id)?.pipelines ?? {}
        context.job_store.updateJob(input.job_id, {
          pipelines: { ...pipelines, typical_application: projected },
        })
      },
    })
    const public_application_result = projectPublicPipelineSnapshot({
      snapshot: application_result,
      artifact_root: job_dir,
      private_roots: [application_invocation_dir],
    })
    const pipelines = context.job_store.getJob(input.job_id)?.pipelines ?? {}
    if (application_result.status === "completed") {
      context.job_store.updateJob(input.job_id, {
        display_status: "complete",
        is_complete: true,
        has_errors: false,
        error_message: undefined,
        completed_at: new Date().toISOString(),
        pipelines: { ...pipelines, typical_application: public_application_result },
      })
      return
    }
    if (application_result.status === "cancelled" || signal.aborted) {
      context.job_store.updateJob(input.job_id, {
        display_status: "cancelled",
        is_complete: true,
        has_errors: false,
        error_message: undefined,
        completed_at: new Date().toISOString(),
        pipelines: { ...pipelines, typical_application: public_application_result },
      })
      return
    }
    const error_message = failureMessage(public_application_result)
    await appendJobLog(
      context.job_store,
      input.job_id,
      "system",
      `Typical-application pipeline failed: ${error_message}\n`,
    ).catch(() => undefined)
    context.job_store.updateJob(input.job_id, {
      display_status: "failed",
      is_complete: true,
      has_errors: true,
      error_message,
      completed_at: new Date().toISOString(),
      pipelines: { ...pipelines, typical_application: public_application_result },
    })
  } catch (error) {
    const cancelled = signal.aborted
    const error_message = error instanceof Error ? error.message : String(error)
    await appendJobLog(
      context.job_store,
      input.job_id,
      "system",
      `${cancelled ? "Component pipeline cancelled" : `Component pipeline crashed: ${error_message}`}\n`,
    ).catch(() => undefined)
    context.job_store.updateJob(input.job_id, {
      display_status: cancelled ? "cancelled" : "failed",
      is_complete: true,
      has_errors: !cancelled,
      error_message: cancelled ? undefined : error_message,
      completed_at: new Date().toISOString(),
    })
  }
}
