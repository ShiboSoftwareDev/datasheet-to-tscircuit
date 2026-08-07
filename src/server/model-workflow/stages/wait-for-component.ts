import { copyFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { isCircuitJson } from "../../component-circuit-json"
import { parseComponentEvidence } from "../../component-evidence"
import type { JobStore } from "../../job-store"
import { ensureJobTscircuitRuntimeConfig } from "../../job-scaffold"
import type { ModelRunStore } from "../../model-run-store"
import {
  assertModelInterfaceIntegrationCompatible,
  createModelInterface,
  parseFreshModelContract,
} from "../../modeling"
import { PipelineError } from "../../pipeline"
import { modelArtifact, readJson, updateModelProgress } from "../stage-helpers"
import { defineModelStage } from "./stage-factory"

type Readiness = "ready" | "failed" | "waiting"

function inspectEvidenceReadiness(input: { job_id: string; job_store: JobStore }): Readiness {
  const job = input.job_store.getJob(input.job_id)
  if (!job) return "failed"
  if (job.evidence_available) return "ready"
  const component_pipeline = job.pipelines?.component_generation ?? job.pipeline
  if (
    job.is_complete ||
    component_pipeline?.status === "failed" ||
    component_pipeline?.status === "cancelled"
  ) {
    return "failed"
  }
  return "waiting"
}

function inspectComponentReadiness(input: { job_id: string; job_store: JobStore }): Readiness {
  const job = input.job_store.getJob(input.job_id)
  if (!job) return "failed"
  if (job.is_complete) {
    return job.display_status === "complete" && job.component_ready && !job.has_errors ? "ready" : "failed"
  }
  const component_pipeline = job.pipelines?.component_generation ?? job.pipeline
  if (component_pipeline?.status === "completed") {
    const committed =
      component_pipeline.pipeline_id === "component_generation"
        ? component_pipeline.stage_results.repair_component?.status === "completed"
        : component_pipeline.stage_results.publish?.status === "completed"
    return !job.has_errors && job.component_ready && committed ? "ready" : "failed"
  }
  if (component_pipeline?.status === "failed" || component_pipeline?.status === "cancelled") {
    return "failed"
  }
  return "waiting"
}

async function waitForTerminalReadiness(input: {
  job_id: string
  job_store: JobStore
  signal: AbortSignal
  inspect: (input: { job_id: string; job_store: JobStore }) => Readiness
}): Promise<void> {
  if (input.signal.aborted || input.inspect(input) !== "waiting") return
  await new Promise<void>((resolve) => {
    let unsubscribe: (() => void) | undefined
    const finish = () => {
      input.signal.removeEventListener("abort", finish)
      unsubscribe?.()
      resolve()
    }
    input.signal.addEventListener("abort", finish, { once: true })
    unsubscribe = input.job_store.subscribe(input.job_id, (event) => {
      if (event.event_type === "job_updated" && input.inspect(input) !== "waiting") finish()
    })
    if (input.inspect(input) !== "waiting") finish()
  })
}

/** Waits only for the committed evidence required by the first model task. */
export async function waitForEvidenceBeforeModelPipeline(input: {
  job_id: string
  model_run_id: string
  job_store: JobStore
  model_run_store: ModelRunStore
  signal: AbortSignal
}): Promise<void> {
  input.model_run_store.updateModelRun(input.model_run_id, {
    status: "setting_up",
    is_complete: false,
    has_errors: false,
    error_message: undefined,
  })
  updateModelProgress({
    store: input.model_run_store,
    model_run_id: input.model_run_id,
    phase: "characterizing",
    message: "Waiting for committed datasheet evidence",
  })
  await waitForTerminalReadiness({ ...input, inspect: inspectEvidenceReadiness })
}

/**
 * Production coordination hook invoked before the wait task input is captured.
 * The task therefore receives the exact completed component bytes it reports.
 */
export async function waitForComponentBeforePublication(input: {
  job_id: string
  model_run_id: string
  job_store: JobStore
  model_run_store: ModelRunStore
  signal: AbortSignal
}): Promise<void> {
  input.model_run_store.updateModelRun(input.model_run_id, {
    status: "waiting_for_component",
    is_complete: false,
    has_errors: false,
    error_message: undefined,
  })
  updateModelProgress({
    store: input.model_run_store,
    model_run_id: input.model_run_id,
    phase: "waiting_for_component",
    message: "Waiting to attach the validated model to the generated component",
  })
  await waitForTerminalReadiness({ ...input, inspect: inspectComponentReadiness })
}

async function copyOptionalRuntimeFiles(input: { job_dir: string; integration_dir: string }): Promise<void> {
  await Promise.all([
    ensureJobTscircuitRuntimeConfig(input.integration_dir),
    ...["package.json", "tsconfig.json", "tscircuit.config.json"].map(async (file_name) => {
      const source = join(input.job_dir, file_name)
      if (await Bun.file(source).exists()) {
        await copyFile(source, join(input.integration_dir, file_name))
      }
    }),
  ])
}

export const waitForComponentStage = defineModelStage({
  id: "wait_for_component",
  depends_on: ["repair_spice_model"],
  async execute({ context, services, dependency_outputs, signal }) {
    signal.throwIfAborted()
    const componentNotReady = (error: unknown): PipelineError =>
      new PipelineError(
        {
          code: "component_not_ready",
          message: error instanceof Error ? error.message : String(error),
          stage_id: "wait_for_component",
          operation: "capture_component_input",
          entity_refs: [{ entity_type: "job", entity_id: context.job_id }],
          hint: "Inspect the component pipeline and its failed stage before retrying publication.",
        },
        { cause: error },
      )
    const readiness = inspectComponentReadiness({ job_id: context.job_id, job_store: services.job_store })
    if (readiness === "failed") {
      const job = services.job_store.getJob(context.job_id)
      throw componentNotReady(
        new Error(job?.error_message ?? "Component generation did not complete successfully"),
      )
    }
    if (readiness === "waiting") {
      throw new PipelineError({
        code: "component_state_not_terminal",
        message: "The retained task input was captured before component generation reached a terminal state",
        stage_id: "wait_for_component",
        operation: "capture_component_input",
        entity_refs: [{ entity_type: "job", entity_id: context.job_id }],
        hint: "Capture this task only after the component synchronization barrier completes.",
      })
    }

    const component_source = (await Bun.file(join(context.job_dir, "component.circuit.tsx")).exists())
      ? join(context.job_dir, "component.circuit.tsx")
      : join(context.job_dir, "index.circuit.tsx")
    const component_circuit_json_source = join(context.job_dir, "component.circuit.json")
    const circuit_json_value: unknown = JSON.parse(await readFile(component_circuit_json_source, "utf8"))
    if (!isCircuitJson(circuit_json_value)) {
      throw componentNotReady(new Error("Validated component Circuit JSON is unavailable or malformed"))
    }
    const evidence = parseComponentEvidence(
      await readJson(join(context.model_dir, "component-evidence.json")),
    )
    const modeled_contract = parseFreshModelContract(
      await readJson(dependency_outputs.repair_spice_model.contract_path),
    )
    const integration_interface = createModelInterface(evidence, circuit_json_value)
    assertModelInterfaceIntegrationCompatible(modeled_contract.interface, integration_interface)

    const integration_dir = join(context.model_dir, "integration-inputs", context.invocation_id)
    await mkdir(integration_dir, { recursive: true })
    const component_source_path = join(integration_dir, "component.circuit.tsx")
    const component_circuit_json_path = join(integration_dir, "component.circuit.json")
    const integration_interface_path = join(integration_dir, "model-interface.json")
    await Promise.all([
      copyFile(component_source, component_source_path),
      copyFile(component_circuit_json_source, component_circuit_json_path),
      Bun.write(integration_interface_path, `${JSON.stringify(integration_interface, null, 2)}\n`),
      copyOptionalRuntimeFiles({ job_dir: context.job_dir, integration_dir }),
    ])
    return {
      status: "completed",
      output: {
        job_id: context.job_id,
        component_source_path,
        component_circuit_json_path,
        integration_interface_path,
        integration_dir,
      },
      artifacts: [
        await modelArtifact({
          id: "validated_component_source",
          path: component_source_path,
          media_type: "text/typescript",
          role: "model_input",
        }),
        await modelArtifact({
          id: "validated_component_circuit_json",
          path: component_circuit_json_path,
          media_type: "application/json",
          role: "model_input",
        }),
        await modelArtifact({
          id: "component_integration_interface",
          path: integration_interface_path,
          media_type: "application/json",
          role: "model_contract",
        }),
      ],
    }
  },
})
