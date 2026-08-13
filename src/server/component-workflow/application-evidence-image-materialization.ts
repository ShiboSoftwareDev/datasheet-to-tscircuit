import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { ProcessError, type ProcessRunner } from "../infrastructure/process"
import {
  applicationDesignEvidenceSources,
  rewriteApplicationDesignEvidenceSources,
  type ApplicationDesignEvidence,
} from "./application-design-evidence"
import type { ApplicationSourceReference, TypicalApplicationPlan } from "./application-plan"

const RENDER_DPI = 200 as const
const MAX_RENDERED_SOURCE_PAGES = 32

export interface ApplicationEvidenceImageManifest {
  version: 1
  renderer: "pdftoppm"
  render_dpi: typeof RENDER_DPI
  source_pdf_sha256: string
  pages: Array<{ page: number; image: string; sha256: string; size_bytes: number }>
  aliases: {
    typical_application?: { page: number; image: string; sha256: string }
  }
}

function sources(plan: TypicalApplicationPlan): ApplicationSourceReference[] {
  return [
    ...plan.source_references,
    ...plan.components.flatMap((component) => [
      ...(component.source_references ?? []),
      ...(component.footprint_source_references ?? []),
    ]),
  ]
}

async function sha256File(path: string): Promise<{ sha256: string; size_bytes: number }> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > 256 * 1024 * 1024) {
    throw new Error(`Application evidence source is not a bounded regular file: ${path}`)
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Application evidence source changed while opening: ${path}`)
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength !== opened.size) {
      throw new Error(`Application evidence source changed while reading: ${path}`)
    }
    return { sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.byteLength }
  } finally {
    await handle.close()
  }
}

function primaryPage(plan: TypicalApplicationPlan): number | undefined {
  if (plan.availability === "not_present") return undefined
  const source = plan.source_references.find(({ method }) => method === "pdf_visual")
  if (!source) throw new Error("Documented typical application must cite a pdf_visual source page")
  return source.page
}

function mapSource(source: ApplicationSourceReference, primary_page: number): ApplicationSourceReference {
  return {
    ...source,
    image:
      source.page === primary_page
        ? "visual-reference/typical-application.png"
        : `visual-reference/source-page-${source.page}.png`,
    render_dpi: RENDER_DPI,
  }
}

function rewritePlan(plan: TypicalApplicationPlan, primary_page: number | undefined): TypicalApplicationPlan {
  const rewriteSource = (source: ApplicationSourceReference) =>
    primary_page === undefined
      ? {
          ...source,
          image: `visual-reference/source-page-${source.page}.png`,
          render_dpi: RENDER_DPI,
        }
      : mapSource(source, primary_page)
  return {
    ...plan,
    source_references: plan.source_references.map(rewriteSource),
    components: plan.components.map((component) => ({
      ...component,
      ...(component.source_references
        ? { source_references: component.source_references.map(rewriteSource) }
        : {}),
      ...(component.footprint_source_references
        ? {
            footprint_source_references: component.footprint_source_references.map(rewriteSource),
          }
        : {}),
    })),
  }
}

export async function materializeApplicationEvidenceImages(input: {
  workspace: string
  application_plan: TypicalApplicationPlan
  application_design_evidence?: ApplicationDesignEvidence
  process_runner: ProcessRunner
  signal: AbortSignal
  on_output?: (stream: "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<{
  application_plan: TypicalApplicationPlan
  application_design_evidence?: ApplicationDesignEvidence
  manifest: ApplicationEvidenceImageManifest
}> {
  const primary_page = primaryPage(input.application_plan)
  const pages = [
    ...new Set(
      [
        ...sources(input.application_plan),
        ...(input.application_design_evidence
          ? applicationDesignEvidenceSources(input.application_design_evidence)
          : []),
      ].map(({ page }) => page),
    ),
  ].sort((left, right) => left - right)
  if (pages.length > MAX_RENDERED_SOURCE_PAGES) {
    throw new Error(
      `Application evidence cites ${pages.length} source pages; the maximum is ${MAX_RENDERED_SOURCE_PAGES}`,
    )
  }
  const visual_root = join(input.workspace, "visual-reference")
  await rm(visual_root, { recursive: true, force: true })
  await mkdir(visual_root, { recursive: true })
  const rendered_pages: ApplicationEvidenceImageManifest["pages"] = []
  for (const page of pages) {
    input.signal.throwIfAborted()
    const relative_image = `visual-reference/source-page-${page}.png`
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
          join(input.workspace, relative_image.slice(0, -4)),
        ],
        command_label: `Render application evidence source page ${page}`,
        cwd: input.workspace,
        signal: input.signal,
        wall_timeout_ms: 120_000,
        max_output_chars: 20_000,
        on_output: input.on_output,
      })
    } catch (error) {
      if (error instanceof ProcessError && error.code === "process_exit_failed") {
        throw new Error(`Application evidence cites PDF page ${page}, but it could not be rendered`, {
          cause: error,
        })
      }
      throw error
    }
    rendered_pages.push({
      page,
      image: relative_image,
      ...(await sha256File(join(input.workspace, relative_image))),
    })
  }
  if (primary_page !== undefined) {
    await Bun.write(
      join(visual_root, "typical-application.png"),
      await readFile(join(visual_root, `source-page-${primary_page}.png`)),
    )
  }
  const manifest: ApplicationEvidenceImageManifest = {
    version: 1,
    renderer: "pdftoppm",
    render_dpi: RENDER_DPI,
    source_pdf_sha256: (await sha256File(join(input.workspace, "datasheet.pdf"))).sha256,
    pages: rendered_pages,
    aliases:
      primary_page === undefined
        ? {}
        : {
            typical_application: {
              page: primary_page,
              image: "visual-reference/typical-application.png",
              sha256: createHash("sha256")
                .update(await readFile(join(visual_root, `source-page-${primary_page}.png`)))
                .digest("hex"),
            },
          },
  }
  await Bun.write(
    join(input.workspace, "application-evidence-image-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  const rewriteSource = (source: ApplicationSourceReference): ApplicationSourceReference => ({
    ...source,
    image:
      primary_page !== undefined && source.page === primary_page
        ? "visual-reference/typical-application.png"
        : `visual-reference/source-page-${source.page}.png`,
    render_dpi: RENDER_DPI,
  })
  return {
    application_plan: rewritePlan(input.application_plan, primary_page),
    ...(input.application_design_evidence
      ? {
          application_design_evidence: rewriteApplicationDesignEvidenceSources(
            input.application_design_evidence,
            rewriteSource,
          ),
        }
      : {}),
    manifest,
  }
}
