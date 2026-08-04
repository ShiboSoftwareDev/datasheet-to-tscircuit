import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  type ComponentEvidence,
  createFootprintPlanFromEvidence,
  parseComponentEvidence,
} from "@/server/component-evidence"
import { createComponentSchematicPlan } from "@/server/component-schematic-plan"
import {
  compareApplicationGraphs,
  parseApplicationConnectivityReview,
} from "@/server/component-workflow/application-connectivity-verification"
import {
  parseTypicalApplicationPlan,
  type TypicalApplicationPlan,
} from "@/server/component-workflow/application-plan"
import { writeEvidenceCommit } from "@/server/component-workflow/evidence-commit"
import {
  compareFootprintGeometry,
  parseFootprintGeometryReview,
} from "@/server/component-workflow/footprint-geometry-verification"

const png_bytes = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
)

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

function requiredVisualSource(
  sources: ReadonlyArray<{
    page: number
    method?: string
    image?: string
  }>,
  image: string,
): { page: number } {
  const source = sources.find((candidate) => candidate.method === "pdf_visual" && candidate.image === image)
  if (!source) throw new Error(`Committed evidence fixture requires a pdf_visual source for ${image}`)
  return source
}

export async function publishCommittedEvidenceFixture(input: {
  job_dir: string
  datasheet?: string | Uint8Array
  component_evidence: unknown
  application_plan: unknown
}): Promise<{
  component_evidence: ComponentEvidence
  application_plan: TypicalApplicationPlan
}> {
  const datasheet = input.datasheet ?? "%PDF-1.7\ncommitted test evidence\n"
  const component_evidence = parseComponentEvidence(input.component_evidence)
  const application_plan = parseTypicalApplicationPlan(input.application_plan, {
    part_number: component_evidence.part_number.value,
    ordering_code: component_evidence.ordering_code?.value,
  })
  const land_pattern_source = requiredVisualSource(
    component_evidence.footprint.drawing_orientation.sources,
    "visual-reference/land-pattern.png",
  )
  const typical_application_source =
    application_plan.availability === "documented"
      ? requiredVisualSource(application_plan.source_references, "visual-reference/typical-application.png")
      : undefined
  const pages = [...new Set([land_pattern_source.page, typical_application_source?.page].filter(Boolean))]
    .map((page) => page as number)
    .sort((left, right) => left - right)
  const image_sha256 = sha256(png_bytes)
  const connectivity_review = parseApplicationConnectivityReview(
    application_plan.availability === "documented"
      ? {
          version: 1,
          availability: "documented",
          source: typical_application_source,
          components: application_plan.components.map(
            ({ reference, kind, value, manufacturer_part_number }) => ({
              reference,
              kind,
              ...(value === undefined ? {} : { value }),
              ...(manufacturer_part_number === undefined ? {} : { manufacturer_part_number }),
            }),
          ),
          connections: application_plan.connections.map(({ pins }) => ({ pins })),
        }
      : {
          version: 1,
          availability: "not_present",
          searched_sections: application_plan.searched_sections,
        },
    application_plan,
  )
  const connectivity_verification = compareApplicationGraphs({
    plan: application_plan,
    review: connectivity_review,
    evidence: component_evidence,
  })
  const footprint_review = parseFootprintGeometryReview(
    {
      version: 1,
      source: land_pattern_source,
      view: "pcb_top",
      units: "mm",
      pads: component_evidence.footprint.pads.map(({ sources: _sources, ...pad }) => pad),
    },
    component_evidence,
  )
  const footprint_verification = compareFootprintGeometry({
    evidence: component_evidence,
    review: footprint_review,
  })
  const image_manifest = {
    version: 1,
    renderer: "pdftoppm",
    render_dpi: 200,
    source_pdf_sha256: sha256(datasheet),
    pages: pages.map((page) => ({
      page,
      image: `visual-reference/source-page-${page}.png`,
      sha256: image_sha256,
      size_bytes: png_bytes.byteLength,
    })),
    aliases: {
      land_pattern: {
        page: land_pattern_source.page,
        image: "visual-reference/land-pattern.png",
        sha256: image_sha256,
      },
      ...(typical_application_source
        ? {
            typical_application: {
              page: typical_application_source.page,
              image: "visual-reference/typical-application.png",
              sha256: image_sha256,
            },
          }
        : {}),
    },
  }

  await mkdir(join(input.job_dir, "visual-reference"), { recursive: true })
  await Promise.all([
    Bun.write(join(input.job_dir, "datasheet.pdf"), datasheet),
    writeJson(join(input.job_dir, "component-evidence.json"), component_evidence),
    writeJson(
      join(input.job_dir, "footprint-plan.json"),
      createFootprintPlanFromEvidence(component_evidence),
    ),
    writeJson(
      join(input.job_dir, "component-schematic-plan.json"),
      createComponentSchematicPlan(component_evidence),
    ),
    writeJson(join(input.job_dir, "typical-application-plan.json"), application_plan),
    writeJson(join(input.job_dir, "footprint-geometry-review.json"), footprint_review),
    writeJson(join(input.job_dir, "footprint-geometry-verification.json"), footprint_verification),
    writeJson(join(input.job_dir, "application-connectivity-review.json"), connectivity_review),
    writeJson(join(input.job_dir, "application-connectivity-verification.json"), connectivity_verification),
    writeJson(join(input.job_dir, "evidence-image-manifest.json"), image_manifest),
    ...pages.map((page) =>
      Bun.write(join(input.job_dir, "visual-reference", `source-page-${page}.png`), png_bytes),
    ),
    Bun.write(join(input.job_dir, "visual-reference", "land-pattern.png"), png_bytes),
    ...(typical_application_source
      ? [Bun.write(join(input.job_dir, "visual-reference", "typical-application.png"), png_bytes)]
      : []),
  ])
  await writeEvidenceCommit(input.job_dir)
  return { component_evidence, application_plan }
}
