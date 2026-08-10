import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { PipelineError } from "../../pipeline"
import { isCircuitJson } from "../../component-circuit-json"
import { readApprovedApplicationEvidence, validateGeneratedSource } from "../stage-helpers"
import { defineApplicationStage } from "./stage-factory"

const WAIT_TIMEOUT_MS = 30 * 60 * 1000

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export const waitForComponentStage = defineApplicationStage({
  id: "wait_for_component",
  depends_on: ["extract_application_evidence"],
  async execute({ context, services, signal }) {
    const application_plan = await readApprovedApplicationEvidence(context.job_dir)
    if (application_plan.availability === "not_present") {
      return {
        status: "completed",
        output: { component_required: false },
        metrics: { component_required: false, wait_duration_ms: 0 },
      }
    }
    const source_path = join(context.job_dir, "component.circuit.tsx")
    const circuit_json_path = join(context.job_dir, "component.circuit.json")
    const started_at = Date.now()
    while (Date.now() - started_at < WAIT_TIMEOUT_MS) {
      signal.throwIfAborted()
      const [source_exists, circuit_json_exists] = await Promise.all([
        Bun.file(source_path).exists(),
        Bun.file(circuit_json_path).exists(),
      ])
      if (source_exists && circuit_json_exists) {
        const [source_bytes, circuit_json_bytes] = await Promise.all([
          readFile(source_path),
          readFile(circuit_json_path),
        ])
        const source = new TextDecoder("utf-8", { fatal: true }).decode(source_bytes)
        validateGeneratedSource(source, "component")
        let circuit_json: unknown
        try {
          circuit_json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(circuit_json_bytes))
        } catch (error) {
          throw new Error("Published component Circuit JSON is not valid UTF-8 JSON", { cause: error })
        }
        if (!isCircuitJson(circuit_json)) {
          throw new Error("Published component Circuit JSON is empty or malformed")
        }
        return {
          status: "completed",
          output: {
            component_required: true,
            component_path: source_path,
            component_circuit_json_path: circuit_json_path,
            component_sha256: sha256(source_bytes),
            component_circuit_json_sha256: sha256(circuit_json_bytes),
          },
          metrics: { component_required: true, wait_duration_ms: Date.now() - started_at },
        }
      }
      const component_pipeline = services.job_store.getJob(context.job_id)?.pipelines?.component_generation
      if (component_pipeline?.status === "failed" || component_pipeline?.status === "cancelled") {
        throw new PipelineError({
          code: "validated_component_required",
          message: "The component pipeline ended before publishing a validated component.",
          stage_id: "wait_for_component",
          operation: "wait_for_component_publication",
          artifact_refs: [{ path: source_path }, { path: circuit_json_path }],
        })
      }
      await delay(1_000, signal)
    }
    throw new PipelineError({
      code: "validated_component_required",
      message: "Timed out waiting for the component pipeline to publish a validated component.",
      stage_id: "wait_for_component",
      operation: "wait_for_component_publication",
      artifact_refs: [{ path: source_path }, { path: circuit_json_path }],
      hint: "Run or resume the component_generation pipeline for this job.",
    })
  },
})
