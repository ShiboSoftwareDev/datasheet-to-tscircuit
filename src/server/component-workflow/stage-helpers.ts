import { readFile } from "node:fs/promises"
import type { AnyCircuitElement } from "circuit-json"
import type { ComponentFootprintPreviews, JobValidation } from "@/shared/job-types"
import { isCircuitElementArray } from "../component-circuit-json"
import {
  type ComponentEvidence,
  type ComponentFootprintCatalog,
  createSingleFootprintCatalog,
  createFootprintPlanFromEvidence,
  parseComponentFootprintCatalog,
  parseComponentEvidence,
} from "../component-evidence"
import { type ComponentSchematicPlan, createComponentSchematicPlan } from "../component-schematic-plan"
import type { FootprintPlan } from "../job-artifact-validator"
import type { JobStore } from "../job-store"
import { createPipelineArtifact, type PipelineArtifact } from "../pipeline"
import { getComponentSourceStructureErrors } from "./component-source-validation"
import {
  applicationTargetIdentityFromEvidence,
  parseTypicalApplicationPlan,
  type TypicalApplicationPlan,
} from "./application-plan"
import {
  applicationEvidenceFilePath,
  type CommittedApplicationEvidenceSnapshot,
  readCommittedApplicationEvidenceSnapshot,
} from "./application-evidence-commit"
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
}

function parseCommittedJson(snapshot: CommittedEvidenceSnapshot, relative_path: string): unknown {
  const bytes = snapshot.files.get(relative_path)
  if (!bytes) throw new Error(`Committed evidence snapshot is missing ${relative_path}`)
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    return parsed
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
  }
}

export interface ApprovedEvidenceBundle {
  snapshot: CommittedEvidenceSnapshot
  evidence: ApprovedComponentEvidence
}

export async function readApprovedComponentEvidenceBundle(job_dir: string): Promise<ApprovedEvidenceBundle> {
  const snapshot = await readCommittedEvidenceSnapshot(job_dir)
  if (!snapshot) {
    throw new Error("Approved evidence is unavailable because evidence-commit.json has not been published")
  }
  return { snapshot, evidence: parseApprovedEvidenceSnapshot(snapshot) }
}

export async function readApprovedEvidence(job_dir: string): Promise<ApprovedComponentEvidence> {
  return (await readApprovedComponentEvidenceBundle(job_dir)).evidence
}

export function parseApprovedFootprintCatalogSnapshot(
  snapshot: CommittedEvidenceSnapshot,
): ComponentFootprintCatalog {
  if (!snapshot.files.has("component-footprint-catalog.json")) {
    return createSingleFootprintCatalog({
      component_evidence: parseApprovedEvidenceSnapshot(snapshot).component_evidence,
    })
  }
  return parseComponentFootprintCatalog(parseCommittedJson(snapshot, "component-footprint-catalog.json"))
}

export async function readApprovedComponentFootprintCatalog(
  job_dir: string,
): Promise<ComponentFootprintCatalog> {
  const snapshot = await readCommittedEvidenceSnapshot(job_dir)
  if (!snapshot) {
    throw new Error("Approved evidence is unavailable because evidence-commit.json has not been published")
  }
  return parseApprovedFootprintCatalogSnapshot(snapshot)
}

export function componentFootprintPreviewsFromCatalog(
  catalog: ComponentFootprintCatalog,
): ComponentFootprintPreviews {
  return {
    default_footprint_id: catalog.default_footprint_id,
    footprints: catalog.footprints.map((footprint) => ({
      footprint_id: footprint.footprint_id,
      label: footprint.label,
      aliases: footprint.aliases,
      ordering_codes: footprint.ordering_codes,
      package_name: footprint.component_evidence.package.name.value,
      ...(footprint.component_evidence.package.code
        ? { package_code: footprint.component_evidence.package.code.value }
        : {}),
      pin_count: footprint.component_evidence.package.pin_count.value,
    })),
  }
}

function parseCommittedApplicationJson(
  snapshot: CommittedApplicationEvidenceSnapshot,
  relative_path: string,
): unknown {
  const bytes = snapshot.files.get(applicationEvidenceFilePath(relative_path))
  if (!bytes) throw new Error(`Committed application evidence is missing ${relative_path}`)
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    return parsed
  } catch (error) {
    throw new Error(`Committed application evidence contains invalid JSON at ${relative_path}`, {
      cause: error,
    })
  }
}

export interface ApprovedApplicationEvidenceBundle {
  snapshot: CommittedApplicationEvidenceSnapshot
  application_plan: TypicalApplicationPlan
}

export async function readApprovedApplicationEvidenceBundle(
  job_dir: string,
): Promise<ApprovedApplicationEvidenceBundle> {
  const snapshot = await readCommittedApplicationEvidenceSnapshot(job_dir)
  if (!snapshot) {
    throw new Error(
      "Approved application evidence is unavailable because application-evidence-commit.json has not been published",
    )
  }
  return {
    snapshot,
    application_plan: parseTypicalApplicationPlan(
      parseCommittedApplicationJson(snapshot, "typical-application-plan.json"),
    ),
  }
}

export async function readApprovedApplicationEvidence(job_dir: string): Promise<TypicalApplicationPlan> {
  return (await readApprovedApplicationEvidenceBundle(job_dir)).application_plan
}

/** Resolve the independently extracted U1 endpoints against component evidence. */
export async function readComponentBoundApplicationEvidence(
  job_dir: string,
): Promise<TypicalApplicationPlan> {
  const [application_plan, component] = await Promise.all([
    readApprovedApplicationEvidence(job_dir),
    readApprovedEvidence(job_dir),
  ])
  return parseTypicalApplicationPlan(
    application_plan,
    applicationTargetIdentityFromEvidence(component.component_evidence),
  )
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
}

export async function readCircuitValidationRecord(path: string): Promise<CircuitValidationRecord> {
  const value = await readJson(path)
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("passed" in value) ||
    typeof value.passed !== "boolean" ||
    !("errors" in value) ||
    !Array.isArray(value.errors) ||
    !value.errors.every((entry) => typeof entry === "string") ||
    !("circuit_json" in value) ||
    !isCircuitElementArray(value.circuit_json)
  ) {
    throw new Error(`Circuit validation record is invalid: ${path}`)
  }
  return {
    version: 1,
    passed: value.passed,
    errors: [...value.errors],
    circuit_json: value.circuit_json,
  }
}

export function validateGeneratedSource(source: string, kind: "component" | "application"): void {
  if (!/\bexport\s+default\b/.test(source)) {
    throw new Error(`${kind} source must contain a default export`)
  }
  if (/placementDrcChecksDisabled|routingDisabled|ignore-placement-drc/i.test(source)) {
    throw new Error(`${kind} source disables a required server validation`)
  }
  if (/\bas\s+(?:any|unknown)\b|:\s*any\b/.test(source)) {
    throw new Error(`${kind} source uses an unsafe TypeScript escape hatch`)
  }
  if (kind === "application" && !/\bfrom\s*["']\.\/component\.circuit(?:\.tsx)?["']/.test(source)) {
    throw new Error("application source must import ./component.circuit")
  }
  if (kind === "component") {
    const structure_errors = getComponentSourceStructureErrors(source)
    if (structure_errors.length > 0) {
      throw new Error(structure_errors.join("\n"))
    }
  }
}
