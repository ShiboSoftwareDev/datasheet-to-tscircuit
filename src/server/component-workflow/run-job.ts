import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { PublicPipelineSnapshot } from "@/shared/job-types"
import { TsciAgentClient } from "../infrastructure/agent"
import { BunProcessRunner } from "../infrastructure/process"
import { projectPublicPipelineSnapshot, runPipeline } from "../pipeline"
import { APPLICATION_PIPELINE, COMPONENT_PIPELINE } from "./component-pipeline"
import { appendJobLog } from "./stage-helpers"
import type { ComponentPipelineServices, JobRunnerContext } from "./types"

function failureMessage(result: PublicPipelineSnapshot, pipeline_label: string): string {
  for (const stage of Object.values(result.stage_results)) {
    if (stage.status === "failed" && stage.error) {
      return `[${stage.stage_id}/${stage.error.code}] ${stage.error.message}\nTrace: ${stage.debug_ref}`
    }
  }
  return `${pipeline_label} pipeline failed without a stage diagnostic.`
}

export async function runJob(
  input: { job_id: string; additional_instructions?: string },
  context: JobRunnerContext,
): Promise<void> {
  const job_dir = context.job_store.getJobDir(input.job_id)
  const signal = context.job_store.getCancellationSignal(input.job_id)
  const job = context.job_store.getJob(input.job_id)
  if (!job_dir || !signal || !job) throw new Error(`Job ${input.job_id} was not found`)
  const coordinated_pipeline_ids = [COMPONENT_PIPELINE.pipeline_id, APPLICATION_PIPELINE.pipeline_id] as const
  if (!context.job_store.claimCoordinatedPipelineExecutions(input.job_id, coordinated_pipeline_ids)) {
    return
  }
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
    const application_invocation_id = crypto.randomUUID()
    const application_invocation_dir = join(
      job_dir,
      "runs",
      APPLICATION_PIPELINE.pipeline_id,
      application_invocation_id,
    )
    await mkdir(application_invocation_dir, { recursive: true })
    const pipeline_context = (invocation_id: string) => ({
      job_id: input.job_id,
      job_dir,
      additional_instructions: input.additional_instructions,
      use_openai: job.use_openai ?? context.use_openai ?? false,
      invocation_id,
    })
    const [component_result, application_result] = await Promise.all([
      runPipeline({
        definition: COMPONENT_PIPELINE,
        run_id: input.job_id,
        workspace_dir: component_invocation_dir,
        context: pipeline_context(component_invocation_id),
        services,
        task_input_root: job_dir,
        task_input_excluded_roots: ["spice"],
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
      }),
      runPipeline({
        definition: APPLICATION_PIPELINE,
        run_id: input.job_id,
        workspace_dir: application_invocation_dir,
        context: pipeline_context(application_invocation_id),
        services,
        task_input_root: job_dir,
        task_input_excluded_roots: ["spice"],
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
      }),
    ])
    const public_component_result = projectPublicPipelineSnapshot({
      snapshot: component_result,
      artifact_root: job_dir,
      private_roots: [component_invocation_dir],
    })
    const public_application_result = projectPublicPipelineSnapshot({
      snapshot: application_result,
      artifact_root: job_dir,
      private_roots: [application_invocation_dir],
    })
    const pipelines = context.job_store.getJob(input.job_id)?.pipelines ?? {}
    const public_pipelines = {
      ...pipelines,
      component_generation: public_component_result,
      typical_application: public_application_result,
    }
    if (
      signal.aborted ||
      component_result.status === "cancelled" ||
      application_result.status === "cancelled"
    ) {
      await appendJobLog(
        context.job_store,
        input.job_id,
        "system",
        "Component and typical-application work was cancelled.\n",
      ).catch(() => undefined)
      context.job_store.updateJob(input.job_id, {
        display_status: "cancelled",
        is_complete: true,
        has_errors: false,
        error_message: undefined,
        completed_at: new Date().toISOString(),
        pipeline: public_component_result,
        pipelines: public_pipelines,
      })
      return
    }
    const failed_pipeline =
      component_result.status === "failed"
        ? { label: "Component", result: public_component_result }
        : application_result.status === "failed"
          ? { label: "Typical-application", result: public_application_result }
          : undefined
    if (failed_pipeline) {
      const error_message = failureMessage(failed_pipeline.result, failed_pipeline.label)
      await appendJobLog(
        context.job_store,
        input.job_id,
        "system",
        `${failed_pipeline.label} pipeline failed: ${error_message}\n`,
      ).catch(() => undefined)
      context.job_store.updateJob(input.job_id, {
        display_status: "failed",
        is_complete: true,
        has_errors: true,
        error_message,
        completed_at: new Date().toISOString(),
        pipeline: public_component_result,
        pipelines: public_pipelines,
      })
      return
    }
    context.job_store.updateJob(input.job_id, {
      display_status: "complete",
      is_complete: true,
      has_errors: false,
      error_message: undefined,
      completed_at: new Date().toISOString(),
      pipeline: public_component_result,
      pipelines: public_pipelines,
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
  } finally {
    for (const pipeline_id of coordinated_pipeline_ids) {
      context.job_store.releasePipelineExecution(input.job_id, pipeline_id)
    }
  }
}
