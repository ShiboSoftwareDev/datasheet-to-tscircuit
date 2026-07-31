import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import type { JobValidation } from "@/shared/job-types"
import { createPipelineArtifact, type PipelineArtifact } from "../pipeline"
import {
  createFootprintPlanFromEvidence,
  parseComponentEvidence,
  type ComponentEvidence,
} from "../component-evidence"
import { createComponentSchematicPlan, type ComponentSchematicPlan } from "../component-schematic-plan"
import type { FootprintPlan } from "../job-artifact-validator"
import { parseTypicalApplicationPlan, type TypicalApplicationPlan } from "./application-plan"
import type { JobStore } from "../job-store"

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

export async function readApprovedEvidence(job_dir: string): Promise<ApprovedComponentEvidence> {
  const component_evidence = parseComponentEvidence(await readJson(join(job_dir, "component-evidence.json")))
  return {
    component_evidence,
    footprint_plan: createFootprintPlanFromEvidence(component_evidence),
    schematic_plan: createComponentSchematicPlan(component_evidence),
    application_plan: parseTypicalApplicationPlan(
      await readJson(join(job_dir, "typical-application-plan.json")),
      component_evidence.part_number.value,
    ),
  }
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
