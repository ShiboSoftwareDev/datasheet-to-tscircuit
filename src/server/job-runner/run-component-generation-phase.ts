import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { getPinoutEvidenceErrors } from "../component-evidence"
import { getComponentSchematicPlanErrors } from "../component-schematic-plan"
import {
  assertVisualInspectionSnapshotMatches,
  captureVisualInspectionSnapshot,
  getFootprintPlanErrors,
  VisualInspectionInconclusiveError,
  validateVisualInspection,
} from "../job-artifact-validator"
import { buildCircuitArtifact, buildComponentValidationBoard } from "./build-circuit-artifact"
import { buildComponentPrompt } from "./build-component-prompt"
import {
  generationWorkspaceWasModified,
  prepareGenerationWorkspace,
  publishGenerationWorkspace,
  restoreProtectedTree,
} from "./generation-workspace"
import {
  canRetryGenerationFailure,
  generationFailureMessage,
  MAX_GENERATION_ATTEMPTS,
  retainFailedGenerationAttempt,
  sanitizeRetryFeedback,
  shouldDiscardGenerationCheckpoint,
} from "./generation-recovery"
import { assertNoDatasheetAccess } from "./get-forbidden-datasheet-accesses"
import type { JobExecution } from "./job-execution"
import type { ApprovedJobEvidence } from "./run-evidence-phase"
import { runStructuredAgentPhase } from "./run-structured-agent-phase"
import { throwIfCancelled } from "./stream-job-process"

export interface GeneratedComponent {
  component_code: string
  component_circuit_json: AnyCircuitElement[]
  component_snapshot_path: string
}

async function restoreComponentEvidence(
  evidence: ApprovedJobEvidence,
  execution: JobExecution,
): Promise<boolean> {
  const component_evidence_path = join(execution.job_dir, "component-evidence.json")
  const component_schematic_plan_path = join(execution.job_dir, "component-schematic-plan.json")
  const footprint_plan_path = join(execution.job_dir, "footprint-plan.json")
  const typical_application_plan_path = join(execution.job_dir, "typical-application-plan.json")
  const [
    current_evidence,
    current_schematic_plan,
    current_footprint,
    current_application_plan,
    visual_references_modified,
  ] = await Promise.all([
    readFile(component_evidence_path, "utf8").catch(() => undefined),
    readFile(component_schematic_plan_path, "utf8").catch(() => undefined),
    readFile(footprint_plan_path, "utf8").catch(() => undefined),
    readFile(typical_application_plan_path, "utf8").catch(() => undefined),
    restoreProtectedTree(join(execution.job_dir, "visual-reference"), evidence.locked_visual_references),
  ])
  let evidence_files_modified = visual_references_modified
  if (current_evidence !== evidence.component_evidence_text) {
    evidence_files_modified = true
    await Bun.write(component_evidence_path, evidence.component_evidence_text)
  }
  if (current_schematic_plan !== evidence.component_schematic_plan_text) {
    evidence_files_modified = true
    await Bun.write(component_schematic_plan_path, evidence.component_schematic_plan_text)
  }
  if (current_footprint !== evidence.footprint_plan_text) {
    evidence_files_modified = true
    await Bun.write(footprint_plan_path, evidence.footprint_plan_text)
  }
  if (current_application_plan !== evidence.typical_application_plan_text) {
    evidence_files_modified = true
    await Bun.write(typical_application_plan_path, evidence.typical_application_plan_text)
  }
  return evidence_files_modified
}

async function runComponentGenerationAttempt(
  evidence: ApprovedJobEvidence,
  execution: JobExecution,
  attempt: number,
  retry_feedback?: string,
): Promise<GeneratedComponent> {
  throwIfCancelled(execution.cancellation_signal)
  const component_workspace = await prepareGenerationWorkspace(execution.job_dir, "component")
  let evidence_files_modified = false
  let component_events = []
  try {
    component_events = await runStructuredAgentPhase({
      context: execution.context,
      prompt: buildComponentPrompt(execution.additional_instructions, retry_feedback),
      cwd: component_workspace.directory,
      signal: execution.cancellation_signal,
      append: execution.append.bind(execution),
      event_log_file: execution.protected_event_log_file,
      event_publish_file: execution.published_event_log_file,
      event_phase: `component_generation_attempt_${attempt}`,
    })
  } finally {
    try {
      evidence_files_modified = await generationWorkspaceWasModified(component_workspace)
      await publishGenerationWorkspace({
        workspace: component_workspace,
        job_dir: execution.job_dir,
        phase: "component",
      })
    } finally {
      await rm(component_workspace.directory, { recursive: true, force: true })
    }
    if (await restoreComponentEvidence(evidence, execution)) evidence_files_modified = true
  }
  if (evidence_files_modified) {
    throw new Error("The component generation phase modified locked evidence; the server restored it")
  }
  assertNoDatasheetAccess(component_events, "Component generation")

  const component_visual_inspection = await validateVisualInspection({
    job_dir: execution.job_dir,
    events: component_events,
    report_file: "component-visual-inspection.json",
    build_command: "tsci build index.circuit.tsx",
    expected_images: {
      reference: "visual-reference/land-pattern.png",
      pcb: "dist/index/pcb.png",
      schematic: "dist/index/schematic.png",
    },
  })
  if (component_visual_inspection.status !== "passed") {
    execution.updateValidation({ component_visual: "inconclusive" })
    throw new VisualInspectionInconclusiveError(
      "Component image inspection could not be completed automatically",
    )
  }
  const component_visual_snapshot = await captureVisualInspectionSnapshot({
    job_dir: execution.job_dir,
    expected_images: {
      reference: "visual-reference/land-pattern.png",
      pcb: "dist/index/pcb.png",
      schematic: "dist/index/schematic.png",
    },
  })

  const component_path = join(execution.job_dir, "index.circuit.tsx")
  const component_code = await readFile(component_path, "utf8")
  if (!component_code.includes("export default")) {
    throw new Error("The agent did not create a default-exported TSX component")
  }

  execution.context.job_store.updateJob(execution.job_id, { display_status: "building" })
  await execution.append("system", "\nBuilding the generated component with tsci…\n")
  const component_build = await buildCircuitArtifact({
    source_file: "index.circuit.tsx",
    output_stem: "index",
    job_dir: execution.job_dir,
    tsci_bin: execution.context.tsci_bin,
    signal: execution.cancellation_signal,
    append: execution.append.bind(execution),
    render_outputs: true,
    required_checks: ["netlist"],
  })
  if (component_build.errors.length > 0) {
    execution.updateValidation({ component_build: "failed" })
    execution.context.job_store.updateJob(execution.job_id, {
      component_code,
      circuit_json: component_build.circuit_json,
    })
    throw new Error(`Generated component failed clean build validation: ${component_build.errors.join("; ")}`)
  }
  execution.updateValidation({ component_build: "passed" })
  try {
    await assertVisualInspectionSnapshotMatches({
      job_dir: execution.job_dir,
      snapshot: component_visual_snapshot,
    })
  } catch (error) {
    execution.updateValidation({ component_visual: "inconclusive" })
    throw error
  }
  execution.updateValidation({ component_visual: "passed" })
  await execution.append("system", "Authoritative component build reproduced the agent-inspected images.\n")
  const component_circuit_json = component_build.circuit_json

  const footprint_errors = getFootprintPlanErrors(evidence.footprint_plan, component_circuit_json)
  if (footprint_errors.length > 0) {
    execution.updateValidation({ footprint: "failed" })
    execution.context.job_store.updateJob(execution.job_id, {
      component_code,
      circuit_json: component_circuit_json,
    })
    throw new Error(
      `Generated component failed datasheet footprint validation: ${footprint_errors.join("; ")}`,
    )
  }
  execution.updateValidation({ footprint: "passed" })

  const pinout_errors = getPinoutEvidenceErrors(evidence.component_evidence, component_circuit_json)
  if (pinout_errors.length > 0) {
    execution.updateValidation({ pinout: "failed" })
    execution.context.job_store.updateJob(execution.job_id, {
      component_code,
      circuit_json: component_circuit_json,
    })
    throw new Error(`Generated component failed datasheet pin-table validation: ${pinout_errors.join("; ")}`)
  }
  execution.updateValidation({ pinout: "passed" })

  const component_schematic_errors = getComponentSchematicPlanErrors(
    evidence.component_schematic_plan,
    component_circuit_json,
  )
  if (component_schematic_errors.length > 0) {
    execution.updateValidation({ component_schematic: "failed" })
    execution.context.job_store.updateJob(execution.job_id, {
      component_code,
      circuit_json: component_circuit_json,
    })
    throw new Error(
      `Generated component failed deterministic schematic validation: ${component_schematic_errors.join("; ")}`,
    )
  }
  execution.updateValidation({ component_schematic: "passed" })

  await execution.append(
    "system",
    "Validating the reusable component on a server-owned board with tsci placement DRC…\n",
  )
  const component_validation_build = await buildComponentValidationBoard({
    job_dir: execution.job_dir,
    tsci_bin: execution.context.tsci_bin,
    signal: execution.cancellation_signal,
    append: execution.append.bind(execution),
  })
  if (component_validation_build.errors.length > 0) {
    execution.updateValidation({ component_drc: "failed" })
    execution.context.job_store.updateJob(execution.job_id, {
      component_code,
      circuit_json: component_circuit_json,
    })
    throw new Error(
      `Generated component failed board-level tsci validation: ${component_validation_build.errors.join("; ")}`,
    )
  }
  execution.updateValidation({ component_drc: "passed" })

  const component_snapshot_path = join(execution.job_dir, "component.circuit.tsx")
  await Bun.write(component_snapshot_path, component_code)
  await execution.append(
    "system",
    "Component ready. Its code, schematic, and PCB are available; SPICE generation may proceed while the typical application is created.\n",
  )
  execution.context.job_store.updateJob(execution.job_id, {
    display_status: "agent_running",
    is_complete: false,
    has_errors: false,
    component_ready: true,
    component_code,
    circuit_json: component_circuit_json,
  })
  return { component_code, component_circuit_json, component_snapshot_path }
}

export async function runComponentGenerationPhase(
  evidence: ApprovedJobEvidence,
  execution: JobExecution,
): Promise<GeneratedComponent> {
  throwIfCancelled(execution.cancellation_signal)
  execution.active_validation_phase = "component_generation"
  await execution.append("system", "\nGenerating the component from approved evidence only…\n")

  let retry_feedback: string | undefined
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const source_path = join(execution.job_dir, "index.circuit.tsx")
    const source_checkpoint = await readFile(source_path).catch(() => undefined)
    try {
      return await runComponentGenerationAttempt(evidence, execution, attempt, retry_feedback)
    } catch (error) {
      await retainFailedGenerationAttempt({
        job_dir: execution.job_dir,
        phase: "component",
        attempt,
        error,
      }).catch(() => undefined)
      const discard_checkpoint = shouldDiscardGenerationCheckpoint(error)
      if (discard_checkpoint) {
        if (source_checkpoint) await Bun.write(source_path, source_checkpoint)
        else await rm(source_path, { force: true })
      }
      if (
        attempt >= MAX_GENERATION_ATTEMPTS ||
        !canRetryGenerationFailure(error, execution.cancellation_signal)
      ) {
        throw error
      }

      retry_feedback = sanitizeRetryFeedback(generationFailureMessage(error))
      execution.updateValidation({
        component_build: "pending",
        component_drc: "pending",
        footprint: "pending",
        pinout: "pending",
        component_schematic: "pending",
        component_visual: "pending",
      })
      execution.context.job_store.updateJob(execution.job_id, {
        display_status: "agent_running",
        is_complete: false,
        has_errors: false,
      })
      await execution.append(
        "system",
        `Component generation attempt ${attempt} did not pass server validation (${retry_feedback}). ${
          discard_checkpoint
            ? "The candidate was discarded because it touched protected inputs."
            : "The generated source was checkpointed for correction."
        } Retrying automatically (${attempt + 1}/${MAX_GENERATION_ATTEMPTS})…\n`,
      )
    }
  }

  throw new Error("Component generation exhausted its recovery attempts")
}
