import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  type ComponentEvidence,
  createFootprintPlanFromEvidence,
  getComponentEvidenceBlockingReasons,
  getFootprintEvidenceErrors,
  parseComponentEvidence,
} from "../component-evidence"
import { type FootprintPlan, validateAgentImageReads } from "../job-artifact-validator"
import { buildAgentPrompt } from "./build-agent-prompt"
import { parseTypicalApplicationPlan, type TypicalApplicationPlan } from "./parse-typical-application-plan"
import { runStructuredAgentPhase } from "./run-structured-agent-phase"
import {
  AgentTransportUnavailableError,
  AutomatedConversionUnavailableError,
  JobCancelledError,
  type JobRunnerContext,
  type StreamProcessInput,
  throwIfCancelled,
} from "./stream-job-process"

export interface PrimaryEvidenceExtraction {
  component_evidence: ComponentEvidence
  component_evidence_text: string
  footprint_plan: FootprintPlan
  footprint_plan_text: string
  typical_application_plan: TypicalApplicationPlan
  typical_application_plan_text: string
}

async function clearPrimaryEvidenceArtifacts(job_dir: string): Promise<void> {
  await Promise.all([
    rm(join(job_dir, "component-evidence.json"), { force: true }),
    rm(join(job_dir, "footprint-plan.json"), { force: true }),
    rm(join(job_dir, "typical-application-plan.json"), { force: true }),
    rm(join(job_dir, "visual-reference", "land-pattern.png"), { force: true }),
    rm(join(job_dir, "visual-reference", "typical-application.png"), { force: true }),
    rm(join(job_dir, "visual-reference", "pages"), { recursive: true, force: true }),
  ])
}

export function canRetryEvidenceFailure(error: unknown): boolean {
  if (error instanceof JobCancelledError || error instanceof AgentTransportUnavailableError) return false
  const message = error instanceof Error ? error.message : String(error)
  return !/modified index\.circuit\.tsx|created circuit TSX/i.test(message)
}

export async function extractPrimaryEvidenceAttempt(input: {
  context: JobRunnerContext
  job_dir: string
  signal: AbortSignal
  append: StreamProcessInput["on_chunk"]
  additional_instructions?: string
  retry_feedback?: string
  protected_event_log_file: string
  published_event_log_file: string
  starter_component_code?: string
  attempt: number
}): Promise<PrimaryEvidenceExtraction> {
  if (input.attempt > 1) await clearPrimaryEvidenceArtifacts(input.job_dir)
  const component_path = join(input.job_dir, "index.circuit.tsx")
  const events = await runStructuredAgentPhase({
    context: input.context,
    prompt: buildAgentPrompt(input.additional_instructions, input.retry_feedback),
    cwd: input.job_dir,
    signal: input.signal,
    append: input.append,
    event_log_file: input.protected_event_log_file,
    event_publish_file: input.published_event_log_file,
    event_phase: `primary_evidence_attempt_${input.attempt}`,
  })
  throwIfCancelled(input.signal)
  const component_after_evidence = await readFile(component_path, "utf8").catch(() => undefined)
  if (component_after_evidence !== input.starter_component_code) {
    if (input.starter_component_code === undefined) await rm(component_path, { force: true })
    else await Bun.write(component_path, input.starter_component_code)
    throw new Error("The evidence phase modified index.circuit.tsx before evidence approval")
  }
  if (await Bun.file(join(input.job_dir, "typical-application.circuit.tsx")).exists()) {
    await rm(join(input.job_dir, "typical-application.circuit.tsx"), { force: true })
    throw new Error("The evidence phase created circuit TSX before evidence approval")
  }

  const component_evidence_text = await readFile(join(input.job_dir, "component-evidence.json"), "utf8")
  const component_evidence = parseComponentEvidence(JSON.parse(component_evidence_text))
  const typical_application_plan_raw_text = await readFile(
    join(input.job_dir, "typical-application-plan.json"),
    "utf8",
  )
  const typical_application_plan = parseTypicalApplicationPlan(
    JSON.parse(typical_application_plan_raw_text),
    component_evidence.part_number.value,
  )
  if (typical_application_plan.version !== 4) {
    throw new Error("New evidence extraction must use typical-application plan schema version 4")
  }
  const typical_application_plan_text = `${JSON.stringify(typical_application_plan, null, 2)}\n`
  if (typical_application_plan_text !== typical_application_plan_raw_text) {
    await Bun.write(join(input.job_dir, "typical-application-plan.json"), typical_application_plan_text)
  }
  await validateAgentImageReads({
    job_dir: input.job_dir,
    events,
    allow_identical_copies: true,
    expected_images: [
      "visual-reference/land-pattern.png",
      ...(typical_application_plan.availability === "documented"
        ? ["visual-reference/typical-application.png"]
        : []),
    ],
  })
  const footprint_plan = createFootprintPlanFromEvidence(component_evidence)
  const footprint_plan_text = `${JSON.stringify(footprint_plan, null, 2)}\n`
  await Bun.write(join(input.job_dir, "footprint-plan.json"), footprint_plan_text)
  const blocking_reasons = [
    ...getComponentEvidenceBlockingReasons(component_evidence),
    ...getFootprintEvidenceErrors(component_evidence, footprint_plan),
  ]
  if (blocking_reasons.length > 0) {
    throw new AutomatedConversionUnavailableError(
      `Evidence extraction remained unresolved: ${blocking_reasons.join("; ")}`,
    )
  }
  return {
    component_evidence,
    component_evidence_text,
    footprint_plan,
    footprint_plan_text,
    typical_application_plan,
    typical_application_plan_text,
  }
}
