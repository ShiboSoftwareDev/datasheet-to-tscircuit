import { readFile } from "node:fs/promises"
import type { AnyCircuitElement } from "circuit-json"
import type { JobValidation } from "@/shared/job-types"
import {
  type ComponentEvidence,
  createFootprintPlanFromEvidence,
  parseComponentEvidence,
} from "../component-evidence"
import { type ComponentSchematicPlan, createComponentSchematicPlan } from "../component-schematic-plan"
import type { FootprintPlan } from "../job-artifact-validator"
import type { JobStore } from "../job-store"
import { createPipelineArtifact, type PipelineArtifact } from "../pipeline"
import { parseTypicalApplicationPlan, type TypicalApplicationPlan } from "./application-plan"
import { type CommittedEvidenceSnapshot, readCommittedEvidenceSnapshot } from "./evidence-commit"

export const INITIAL_JOB_VALIDATION: JobValidation = {
  evidence: "pending",
  component_build: "pending",
  component_drc: "pending",
  footprint: "pending",
  pinout: "pending",
  component_schematic: "pending",
  component_visual: "pending",
  application_build: "pending",
  application_connectivity: "pending",
  application_schematic: "pending",
  application_visual: "pending",
}

export async function appendJobLog(
  store: JobStore,
  job_id: string,
  stream: "system" | "stdout" | "stderr",
  message: string,
): Promise<void> {
  await store.appendLog(job_id, { stream, message })
}

export async function componentArtifact(input: {
  id: string
  path: string
  media_type: string
  role: string
}): Promise<PipelineArtifact> {
  return createPipelineArtifact({
    artifact_id: input.id,
    path: input.path,
    media_type: input.media_type,
    role: input.role,
  })
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"))
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

export interface ApprovedComponentEvidence {
  component_evidence: ComponentEvidence
  footprint_plan: FootprintPlan
  schematic_plan: ComponentSchematicPlan
  application_plan: TypicalApplicationPlan
}

function parseCommittedJson(snapshot: CommittedEvidenceSnapshot, relative_path: string): unknown {
  const bytes = snapshot.files.get(relative_path)
  if (!bytes) throw new Error(`Committed evidence snapshot is missing ${relative_path}`)
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
  } catch (error) {
    throw new Error(`Committed evidence snapshot contains invalid JSON at ${relative_path}`, {
      cause: error,
    })
  }
}

export function parseApprovedEvidenceSnapshot(
  snapshot: CommittedEvidenceSnapshot,
): ApprovedComponentEvidence {
  const component_evidence = parseComponentEvidence(parseCommittedJson(snapshot, "component-evidence.json"))
  return {
    component_evidence,
    footprint_plan: createFootprintPlanFromEvidence(component_evidence),
    schematic_plan: createComponentSchematicPlan(component_evidence),
    application_plan: parseTypicalApplicationPlan(
      parseCommittedJson(snapshot, "typical-application-plan.json"),
      {
        part_number: component_evidence.part_number.value,
        ordering_code: component_evidence.ordering_code?.value,
      },
    ),
  }
}

export interface ApprovedEvidenceBundle {
  snapshot: CommittedEvidenceSnapshot
  evidence: ApprovedComponentEvidence
}

export async function readApprovedEvidenceBundle(job_dir: string): Promise<ApprovedEvidenceBundle> {
  const snapshot = await readCommittedEvidenceSnapshot(job_dir)
  if (!snapshot) {
    throw new Error("Approved evidence is unavailable because evidence-commit.json has not been published")
  }
  return { snapshot, evidence: parseApprovedEvidenceSnapshot(snapshot) }
}

export async function readApprovedEvidence(job_dir: string): Promise<ApprovedComponentEvidence> {
  return (await readApprovedEvidenceBundle(job_dir)).evidence
}

export function updateJobValidation(
  store: JobStore,
  job_id: string,
  update: Partial<JobValidation>,
): JobValidation {
  const validation = {
    ...INITIAL_JOB_VALIDATION,
    ...store.getJob(job_id)?.validation,
    ...update,
  }
  store.updateJob(job_id, { validation })
  return validation
}

export interface CircuitValidationRecord {
  version: 1
  passed: boolean
  errors: string[]
  circuit_json: AnyCircuitElement[]
  generated_at: string
}

export function validateGeneratedSource(source: string, kind: "component" | "application"): void {
  if (!/\bexport\s+default\b/.test(source)) {
    throw new Error(`${kind} source must contain a default export`)
  }
  if (/placementDrcChecksDisabled|routingDisabled|ignore-placement-drc/i.test(source)) {
    throw new Error(`${kind} source disables a required server validation`)
  }
  if (kind === "application" && !/\bfrom\s*["']\.\/index\.circuit(?:\.tsx)?["']/.test(source)) {
    throw new Error("application source must import ./index.circuit")
  }
}
