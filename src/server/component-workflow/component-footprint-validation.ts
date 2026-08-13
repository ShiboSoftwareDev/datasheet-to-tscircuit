import { readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { ComponentFootprintPreviews } from "@/shared/job-types"
import { createFootprintPlanFromEvidence } from "../component-evidence"
import { createComponentSchematicPlan } from "../component-schematic-plan"
import type { ProcessRunner } from "../infrastructure/process"
import type { ExpectedFootprintPad } from "../job-artifact-validator"
import type { JobStore } from "../job-store"
import {
  buildComponentCandidate,
  type CircuitBuildRecord,
  readCircuitBuildRecord,
  validateBuiltComponent,
} from "./component-validation"
import {
  componentBuildResultRelativePath,
  componentBuildSourceRelativePath,
  componentValidationResultRelativePath,
} from "./component-footprint-artifacts"
import {
  type CircuitValidationRecord,
  componentFootprintPreviewsFromCatalog,
  readApprovedComponentFootprintCatalog,
  writeJson,
} from "./stage-helpers"

export interface ComponentFootprintBuild {
  footprint_id: string
  build_result_relative_path: string
  validation_result_relative_path: string
  build: CircuitBuildRecord
}

const DEFAULT_VALIDATION_PAD_CLEARANCE_MM = 0.1
const COMPONENT_VARIANT_SOURCE_PATTERN = /^component-variant-[a-z0-9]+(?:-[a-z0-9]+)*\.circuit\.tsx$/
const COMPONENT_VARIANT_DIST_PATTERN = /^component-variant-[a-z0-9]+(?:-[a-z0-9]+)*(?:-validation)?$/

async function removeGeneratedEntries(input: { directory: string; pattern: RegExp }): Promise<void> {
  const entries = await readdir(input.directory, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => input.pattern.test(entry.name))
      .map((entry) => rm(join(input.directory, entry.name), { recursive: entry.isDirectory(), force: true })),
  )
}

async function clearVariantBuildArtifacts(job_dir: string): Promise<void> {
  await Promise.all([
    rm(join(job_dir, "component-variant-builds"), { recursive: true, force: true }),
    removeGeneratedEntries({ directory: job_dir, pattern: COMPONENT_VARIANT_SOURCE_PATTERN }),
    removeGeneratedEntries({ directory: join(job_dir, "dist"), pattern: COMPONENT_VARIANT_DIST_PATTERN }),
  ])
}

function rectangularPadGap(left: ExpectedFootprintPad, right: ExpectedFootprintPad): number {
  const x_gap = Math.abs(left.x - right.x) - (left.width + right.width) / 2
  const y_gap = Math.abs(left.y - right.y) - (left.height + right.height) / 2
  if (x_gap > 0 && y_gap > 0) return Math.hypot(x_gap, y_gap)
  return Math.max(x_gap, y_gap)
}

export function verifiedMinimumPadClearance(pads: readonly ExpectedFootprintPad[]): number {
  let minimum_clearance = DEFAULT_VALIDATION_PAD_CLEARANCE_MM
  for (let left_index = 0; left_index < pads.length; left_index += 1) {
    for (let right_index = left_index + 1; right_index < pads.length; right_index += 1) {
      const gap = rectangularPadGap(pads[left_index]!, pads[right_index]!)
      if (gap > 0) minimum_clearance = Math.min(minimum_clearance, gap)
    }
  }
  return minimum_clearance
}

function componentVariantFixtureSource(footprint_id: string): string {
  return `import Component from "./index.circuit"\n\nexport default function ComponentVariantFixture() {\n  return <Component name="U1" footprintVariant=${JSON.stringify(footprint_id)} />\n}\n`
}

export async function buildComponentFootprintCandidates(input: {
  job_id: string
  job_dir: string
  job_store: JobStore
  tsci_bin: string
  process_runner: ProcessRunner
  signal: AbortSignal
  on_output: (stream: "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<ComponentFootprintBuild[]> {
  const catalog = await readApprovedComponentFootprintCatalog(input.job_dir)
  await clearVariantBuildArtifacts(input.job_dir)
  const builds: ComponentFootprintBuild[] = []
  for (const footprint of catalog.footprints) {
    const footprint_plan = createFootprintPlanFromEvidence(footprint.component_evidence)
    const source_relative_path = componentBuildSourceRelativePath(catalog, footprint)
    if (footprint.footprint_id !== catalog.default_footprint_id) {
      await Bun.write(
        join(input.job_dir, source_relative_path),
        componentVariantFixtureSource(footprint.footprint_id),
      )
    }
    const build_result_relative_path = componentBuildResultRelativePath(catalog, footprint)
    const validation_result_relative_path = componentValidationResultRelativePath(catalog, footprint)
    const build = await buildComponentCandidate({
      ...input,
      source_relative_path,
      output_stem: source_relative_path.replace(/\.circuit\.tsx$/, ""),
      build_result_relative_path,
      minimum_pad_clearance_mm: verifiedMinimumPadClearance(footprint_plan.pads),
    })
    builds.push({
      footprint_id: footprint.footprint_id,
      build_result_relative_path,
      validation_result_relative_path,
      build,
    })
  }
  return builds
}

export async function readComponentFootprintBuilds(job_dir: string): Promise<ComponentFootprintBuild[]> {
  const catalog = await readApprovedComponentFootprintCatalog(job_dir)
  return Promise.all(
    catalog.footprints.map(async (footprint) => {
      const build_result_relative_path = componentBuildResultRelativePath(catalog, footprint)
      return {
        footprint_id: footprint.footprint_id,
        build_result_relative_path,
        validation_result_relative_path: componentValidationResultRelativePath(catalog, footprint),
        build: await readCircuitBuildRecord(join(job_dir, build_result_relative_path)),
      }
    }),
  )
}

export async function validateComponentFootprintCandidates(input: {
  job_id: string
  job_dir: string
  job_store: JobStore
  builds: ComponentFootprintBuild[]
}): Promise<{
  summary: CircuitValidationRecord
  previews: ComponentFootprintPreviews
}> {
  const catalog = await readApprovedComponentFootprintCatalog(input.job_dir)
  await rm(join(input.job_dir, "component-variant-validations"), { recursive: true, force: true })
  const base_previews = componentFootprintPreviewsFromCatalog(catalog)
  const validations: Array<{
    footprint_id: string
    result: CircuitValidationRecord
  }> = []
  for (const footprint of catalog.footprints) {
    const candidate = input.builds.find((build) => build.footprint_id === footprint.footprint_id)
    if (!candidate) throw new Error(`Missing build result for footprint ${footprint.footprint_id}`)
    const result = await validateBuiltComponent({
      job_id: input.job_id,
      job_dir: input.job_dir,
      job_store: input.job_store,
      build: candidate.build,
      evidence: {
        component_evidence: footprint.component_evidence,
        footprint_plan: createFootprintPlanFromEvidence(footprint.component_evidence),
        schematic_plan: createComponentSchematicPlan(footprint.component_evidence),
      },
      validation_result_relative_path: candidate.validation_result_relative_path,
      update_job_validation: footprint.footprint_id === catalog.default_footprint_id,
    })
    validations.push({
      footprint_id: footprint.footprint_id,
      result,
    })
  }
  const default_validation = validations.find(
    (validation) => validation.footprint_id === catalog.default_footprint_id,
  )
  if (!default_validation) throw new Error("Component validation produced no default footprint result")
  const summary: CircuitValidationRecord = {
    version: 1,
    passed: validations.every((validation) => validation.result.passed),
    errors: validations.flatMap((validation) =>
      validation.result.errors.map((error) => `${validation.footprint_id}: ${error}`),
    ),
    circuit_json: default_validation.result.circuit_json,
  }
  await writeJson(join(input.job_dir, "component-validation.json"), summary)
  const component_source = await readFile(join(input.job_dir, "index.circuit.tsx"), "utf8")
  const previews: ComponentFootprintPreviews = {
    ...base_previews,
    footprints: base_previews.footprints.map((footprint) => {
      const validation = validations.find((candidate) => candidate.footprint_id === footprint.footprint_id)
      if (!validation) return footprint
      return {
        ...footprint,
        circuit_json: validation.result.circuit_json,
      }
    }),
  }
  input.job_store.updateJob(input.job_id, {
    component_code: component_source,
    circuit_json: default_validation.result.circuit_json,
    component_footprints: previews,
  })
  return { summary, previews }
}
