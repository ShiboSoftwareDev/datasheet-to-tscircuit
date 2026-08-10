import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { ComponentEvidence, EvidenceSource } from "../component-evidence"
import { ProcessError, type ProcessRunner } from "../infrastructure/process"
import type { ApplicationSourceReference, TypicalApplicationPlan } from "./application-plan"

const RENDER_DPI = 200 as const
const MAX_RENDERED_SOURCE_PAGES = 32

interface RenderedEvidencePage {
  page: number
  image: string
  sha256: string
  size_bytes: number
}

export interface EvidenceImageManifest {
  version: 1
  renderer: "pdftoppm"
  render_dpi: typeof RENDER_DPI
  source_pdf_sha256: string
  pages: RenderedEvidencePage[]
  aliases: {
    land_pattern: { page: number; image: string; sha256: string }
    typical_application?: { page: number; image: string; sha256: string }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`)
  }
  return value
}

export function parseEvidenceImageManifest(value: unknown): EvidenceImageManifest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.renderer !== "pdftoppm" ||
    value.render_dpi !== RENDER_DPI
  ) {
    throw new Error("evidence-image-manifest.json must be a pdftoppm version-1 manifest at 200 DPI")
  }
  if (
    !Array.isArray(value.pages) ||
    value.pages.length === 0 ||
    value.pages.length > MAX_RENDERED_SOURCE_PAGES
  ) {
    throw new Error(
      `evidence-image-manifest.json pages must contain 1-${MAX_RENDERED_SOURCE_PAGES} rendered pages`,
    )
  }
  const seen_pages = new Set<number>()
  const pages = value.pages.map((entry, index): RenderedEvidencePage => {
    if (
      !isRecord(entry) ||
      !Number.isInteger(entry.page) ||
      (entry.page as number) < 1 ||
      entry.image !== `visual-reference/source-page-${entry.page}.png` ||
      !Number.isInteger(entry.size_bytes) ||
      (entry.size_bytes as number) < 1
    ) {
      throw new Error(`evidence-image-manifest.json pages[${index}] is invalid`)
    }
    const page = entry.page as number
    if (seen_pages.has(page)) throw new Error(`evidence-image-manifest.json repeats PDF page ${page}`)
    seen_pages.add(page)
    return {
      page,
      image: entry.image,
      sha256: requiredSha256(entry.sha256, `evidence-image-manifest.json pages[${index}].sha256`),
      size_bytes: entry.size_bytes as number,
    }
  })
  if (!isRecord(value.aliases) || !isRecord(value.aliases.land_pattern)) {
    throw new Error("evidence-image-manifest.json must identify the land-pattern source page")
  }
  const parseAlias = (
    alias: Record<string, unknown>,
    label: "land_pattern" | "typical_application",
  ): { page: number; image: string; sha256: string } => {
    const expected_image =
      label === "land_pattern"
        ? "visual-reference/land-pattern.png"
        : "visual-reference/typical-application.png"
    if (!Number.isInteger(alias.page) || (alias.page as number) < 1 || alias.image !== expected_image) {
      throw new Error(`evidence-image-manifest.json aliases.${label} is invalid`)
    }
    const page = alias.page as number
    const rendered = pages.find((entry) => entry.page === page)
    const sha256 = requiredSha256(alias.sha256, `evidence-image-manifest.json aliases.${label}.sha256`)
    if (!rendered || rendered.sha256 !== sha256) {
      throw new Error(`evidence-image-manifest.json aliases.${label} does not match its source page`)
    }
    return { page, image: expected_image, sha256 }
  }
  const land_pattern = parseAlias(value.aliases.land_pattern, "land_pattern")
  const typical_application =
    value.aliases.typical_application === undefined
      ? undefined
      : isRecord(value.aliases.typical_application)
        ? parseAlias(value.aliases.typical_application, "typical_application")
        : (() => {
            throw new Error("evidence-image-manifest.json aliases.typical_application is invalid")
          })()
  return {
    version: 1,
    renderer: "pdftoppm",
    render_dpi: RENDER_DPI,
    source_pdf_sha256: requiredSha256(
      value.source_pdf_sha256,
      "evidence-image-manifest.json source_pdf_sha256",
    ),
    pages,
    aliases: { land_pattern, ...(typical_application ? { typical_application } : {}) },
  }
}

export async function assertEvidenceImageManifest(input: {
  root: string
  manifest: EvidenceImageManifest
  application_available: boolean
}): Promise<void> {
  if (input.application_available !== Boolean(input.manifest.aliases.typical_application)) {
    throw new Error(
      input.application_available
        ? "Documented application evidence is missing its server-rendered image alias"
        : "Not-present application evidence must not contain a typical-application image alias",
    )
  }
  const source_pdf = await sha256File(join(input.root, "datasheet.pdf"))
  if (source_pdf.sha256 !== input.manifest.source_pdf_sha256) {
    throw new Error("Evidence image manifest is bound to a different datasheet.pdf")
  }
  for (const page of input.manifest.pages) {
    const actual = await sha256File(join(input.root, page.image))
    if (actual.sha256 !== page.sha256 || actual.size_bytes !== page.size_bytes) {
      throw new Error(`Server-rendered evidence page changed after rendering: ${page.image}`)
    }
  }
  for (const alias of [input.manifest.aliases.land_pattern, input.manifest.aliases.typical_application]) {
    if (!alias) continue
    const actual = await sha256File(join(input.root, alias.image))
    if (actual.sha256 !== alias.sha256) {
      throw new Error(`Evidence image alias does not match its rendered PDF page: ${alias.image}`)
    }
  }
}

function mapSource<T extends EvidenceSource | ApplicationSourceReference>(
  source: T,
  imageForPage: (page: number) => string,
): T {
  return {
    ...source,
    image: imageForPage(source.page),
    render_dpi: RENDER_DPI,
  }
}

function mapSources<T extends EvidenceSource | ApplicationSourceReference>(
  sources: readonly T[],
  imageForPage: (page: number) => string,
): T[] {
  return sources.map((source) => mapSource(source, imageForPage))
}

function collectComponentSources(evidence: ComponentEvidence): EvidenceSource[] {
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

function collectApplicationSources(plan: TypicalApplicationPlan): ApplicationSourceReference[] {
  return [
    ...plan.source_references,
    ...plan.components.flatMap((component) => [
      ...(component.source_references ?? []),
      ...(component.footprint_source_references ?? []),
    ]),
  ]
}

function primaryVisualPage(
  sources: readonly (EvidenceSource | ApplicationSourceReference)[],
  label: string,
): number {
  const source = sources.find(({ method }) => method === "pdf_visual")
  if (!source) throw new Error(`${label} must cite a pdf_visual source page`)
  return source.page
}

function rewriteComponentEvidence(evidence: ComponentEvidence, land_pattern_page: number): ComponentEvidence {
  const genericImage = (page: number) => `visual-reference/source-page-${page}.png`
  const footprintImage = (page: number) =>
    page === land_pattern_page ? "visual-reference/land-pattern.png" : genericImage(page)
  return {
    ...evidence,
    part_number: { ...evidence.part_number, sources: mapSources(evidence.part_number.sources, genericImage) },
    ...(evidence.ordering_code
      ? {
          ordering_code: {
            ...evidence.ordering_code,
            sources: mapSources(evidence.ordering_code.sources, genericImage),
          },
        }
      : {}),
    package: {
      name: { ...evidence.package.name, sources: mapSources(evidence.package.name.sources, genericImage) },
      ...(evidence.package.code
        ? {
            code: {
              ...evidence.package.code,
              sources: mapSources(evidence.package.code.sources, genericImage),
            },
          }
        : {}),
      pin_count: {
        ...evidence.package.pin_count,
        sources: mapSources(evidence.package.pin_count.sources, genericImage),
      },
    },
    pinout: {
      pins: evidence.pinout.pins.map((pin) => ({
        ...pin,
        sources: mapSources(pin.sources, genericImage),
      })),
    },
    footprint: {
      ...evidence.footprint,
      drawing_orientation: {
        ...evidence.footprint.drawing_orientation,
        sources: mapSources(evidence.footprint.drawing_orientation.sources, footprintImage),
      },
      pads: evidence.footprint.pads.map((pad) => ({
        ...pad,
        sources: mapSources(pad.sources, footprintImage),
      })),
    },
  }
}

function rewriteApplicationPlan(
  plan: TypicalApplicationPlan,
  typical_application_page: number | undefined,
): TypicalApplicationPlan {
  const imageForPage = (page: number) =>
    page === typical_application_page
      ? "visual-reference/typical-application.png"
      : `visual-reference/source-page-${page}.png`
  return {
    ...plan,
    source_references: mapSources(plan.source_references, imageForPage),
    components: plan.components.map((component) => ({
      ...component,
      ...(component.source_references
        ? { source_references: mapSources(component.source_references, imageForPage) }
        : {}),
      ...(component.footprint_source_references
        ? {
            footprint_source_references: mapSources(component.footprint_source_references, imageForPage),
          }
        : {}),
    })),
  }
}

async function sha256File(
  path: string,
  max_bytes = 256 * 1024 * 1024,
): Promise<{ sha256: string; size_bytes: number }> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > max_bytes) {
    throw new Error(`Evidence source is not a bounded regular file: ${path}`)
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > max_bytes
    ) {
      throw new Error(`Evidence source changed while opening: ${path}`)
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength !== opened.size) throw new Error(`Evidence source changed while reading: ${path}`)
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.byteLength,
    }
  } finally {
    await handle.close()
  }
}

/**
 * Replaces every agent-authored evidence image with a deterministic full-page
 * render made directly from datasheet.pdf. The returned evidence cites only
 * these server-owned bytes.
 */
async function materializeEvidenceImagesInternal(input: {
  workspace: string
  component_evidence: ComponentEvidence
  application_plan?: TypicalApplicationPlan
  process_runner: ProcessRunner
  signal: AbortSignal
  on_output?: (stream: "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<{
  component_evidence: ComponentEvidence
  application_plan?: TypicalApplicationPlan
  manifest: EvidenceImageManifest
}> {
  const land_pattern_page = primaryVisualPage(
    [
      ...input.component_evidence.footprint.pads.flatMap(({ sources }) => sources),
      ...input.component_evidence.footprint.drawing_orientation.sources,
    ],
    "Copper land-pattern geometry",
  )
  const typical_application_page =
    input.application_plan?.availability === "documented"
      ? primaryVisualPage(input.application_plan.source_references, "Documented typical application")
      : undefined
  const all_sources = [
    ...collectComponentSources(input.component_evidence),
    ...(input.application_plan ? collectApplicationSources(input.application_plan) : []),
  ]
  const pages = [...new Set(all_sources.map(({ page }) => page))].sort((left, right) => left - right)
  if (pages.length > MAX_RENDERED_SOURCE_PAGES) {
    throw new Error(
      `Evidence cites ${pages.length} visual source pages; the maximum is ${MAX_RENDERED_SOURCE_PAGES}`,
    )
  }
  if (!pages.includes(land_pattern_page)) pages.push(land_pattern_page)
  if (typical_application_page !== undefined && !pages.includes(typical_application_page)) {
    pages.push(typical_application_page)
  }
  pages.sort((left, right) => left - right)

  const visual_root = join(input.workspace, "visual-reference")
  await rm(visual_root, { recursive: true, force: true })
  await mkdir(visual_root, { recursive: true })
  const rendered_pages: RenderedEvidencePage[] = []
  for (const page of pages) {
    input.signal.throwIfAborted()
    const relative_image = `visual-reference/source-page-${page}.png`
    const output_prefix = join(input.workspace, relative_image.slice(0, -4))
    try {
      await input.process_runner.run({
        command: [
          "pdftoppm",
          "-f",
          String(page),
          "-l",
          String(page),
          "-r",
          String(RENDER_DPI),
          "-png",
          "-singlefile",
          join(input.workspace, "datasheet.pdf"),
          output_prefix,
        ],
        command_label: `Render evidence source page ${page}`,
        cwd: input.workspace,
        signal: input.signal,
        wall_timeout_ms: 120_000,
        max_output_chars: 20_000,
        on_output: input.on_output,
      })
    } catch (error) {
      if (error instanceof ProcessError && error.code === "process_exit_failed") {
        throw new Error(
          `Evidence cites PDF page ${page}, but pdftoppm could not render it; verify every cited page number`,
          { cause: error },
        )
      }
      throw error
    }
    rendered_pages.push({
      page,
      image: relative_image,
      ...(await sha256File(join(input.workspace, relative_image))),
    })
  }

  const pagePath = (page: number) => join(visual_root, `source-page-${page}.png`)
  await Bun.write(join(visual_root, "land-pattern.png"), await readFile(pagePath(land_pattern_page)))
  if (typical_application_page !== undefined) {
    await Bun.write(
      join(visual_root, "typical-application.png"),
      await readFile(pagePath(typical_application_page)),
    )
  }
  const manifest: EvidenceImageManifest = {
    version: 1,
    renderer: "pdftoppm",
    render_dpi: RENDER_DPI,
    source_pdf_sha256: (await sha256File(join(input.workspace, "datasheet.pdf"))).sha256,
    pages: rendered_pages,
    aliases: {
      land_pattern: {
        page: land_pattern_page,
        image: "visual-reference/land-pattern.png",
        sha256: createHash("sha256")
          .update(await readFile(pagePath(land_pattern_page)))
          .digest("hex"),
      },
      ...(typical_application_page === undefined
        ? {}
        : {
            typical_application: {
              page: typical_application_page,
              image: "visual-reference/typical-application.png",
              sha256: createHash("sha256")
                .update(await readFile(pagePath(typical_application_page)))
                .digest("hex"),
            },
          }),
    },
  }
  await Bun.write(
    join(input.workspace, "evidence-image-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return {
    component_evidence: rewriteComponentEvidence(input.component_evidence, land_pattern_page),
    ...(input.application_plan
      ? { application_plan: rewriteApplicationPlan(input.application_plan, typical_application_page) }
      : {}),
    manifest,
  }
}

export async function materializeComponentEvidenceImages(input: {
  workspace: string
  component_evidence: ComponentEvidence
  process_runner: ProcessRunner
  signal: AbortSignal
  on_output?: (stream: "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<{ component_evidence: ComponentEvidence; manifest: EvidenceImageManifest }> {
  const materialized = await materializeEvidenceImagesInternal(input)
  return { component_evidence: materialized.component_evidence, manifest: materialized.manifest }
}

export async function materializeEvidenceImages(input: {
  workspace: string
  component_evidence: ComponentEvidence
  application_plan: TypicalApplicationPlan
  process_runner: ProcessRunner
  signal: AbortSignal
  on_output?: (stream: "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<{
  component_evidence: ComponentEvidence
  application_plan: TypicalApplicationPlan
  manifest: EvidenceImageManifest
}> {
  const materialized = await materializeEvidenceImagesInternal(input)
  if (!materialized.application_plan) {
    throw new Error("Combined evidence materialization did not return an application plan")
  }
  return {
    component_evidence: materialized.component_evidence,
    application_plan: materialized.application_plan,
    manifest: materialized.manifest,
  }
}
