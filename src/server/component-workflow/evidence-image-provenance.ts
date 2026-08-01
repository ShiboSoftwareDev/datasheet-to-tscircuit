import { lstat } from "node:fs/promises"
import { join } from "node:path"
import type { ComponentEvidence, EvidenceSource } from "../component-evidence"
import type { ApplicationSourceReference, TypicalApplicationPlan } from "./application-plan"

function componentSources(evidence: ComponentEvidence): EvidenceSource[] {
  return [
    ...evidence.part_number.sources,
    ...(evidence.ordering_code?.sources ?? []),
    ...evidence.package.name.sources,
    ...(evidence.package.code?.sources ?? []),
    ...evidence.package.pin_count.sources,
    ...evidence.pinout.pins.flatMap(({ sources }) => sources),
    ...evidence.footprint.drawing_orientation.sources,
    ...evidence.footprint.pads.flatMap(({ sources }) => sources),
  ]
}

function applicationSources(plan: TypicalApplicationPlan): ApplicationSourceReference[] {
  return [
    ...plan.source_references,
    ...plan.components.flatMap((component) => [
      ...(component.source_references ?? []),
      ...(component.footprint_source_references ?? []),
    ]),
  ]
}

async function assertSourceImages(input: {
  workspace: string
  label: string
  sources: readonly (EvidenceSource | ApplicationSourceReference)[]
}): Promise<void> {
  for (const [index, source] of input.sources.entries()) {
    if (!source.image) continue
    if (
      !source.image.startsWith("visual-reference/") ||
      source.image.split(/[\\/]/).some((segment) => segment === "..")
    ) {
      throw new Error(`${input.label}[${index}].image must stay below visual-reference/`)
    }
    const metadata = await lstat(join(input.workspace, source.image)).catch(() => undefined)
    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`${input.label}[${index}] references missing evidence image ${source.image}`)
    }
  }
}

export async function assertEvidenceImageProvenance(input: {
  workspace: string
  component_evidence: ComponentEvidence
  application_plan: TypicalApplicationPlan
}): Promise<void> {
  await Promise.all([
    assertSourceImages({
      workspace: input.workspace,
      label: "component evidence sources",
      sources: componentSources(input.component_evidence),
    }),
    assertSourceImages({
      workspace: input.workspace,
      label: "typical application sources",
      sources: applicationSources(input.application_plan),
    }),
  ])
}
