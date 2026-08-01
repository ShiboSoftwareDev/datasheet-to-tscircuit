import { lstat, mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  createStageWorkspace,
  promoteStageFile,
  validatePngArtifact,
  validateStageDirectory,
} from "../infrastructure/artifacts"
import type { ProcessRunner } from "../infrastructure/process"
import type { ModelCharacterization } from "../modeling"

const MODEL_EVIDENCE_DPI = 200
const MAX_MODEL_EVIDENCE_PAGES = 16
const MAX_RENDERED_EVIDENCE_BYTES = 64 * 1024 * 1024

/**
 * Renders cited datasheet pages with a server-owned tool and binds every
 * modeled requirement to those trusted pixels. Agent-authored crops may remain
 * as debug aids, but they never become the canonical UI reference.
 */
export async function materializeModelEvidencePages(input: {
  workspace: string
  datasheet_path: string
  characterization: ModelCharacterization
  process_runner: ProcessRunner
  signal: AbortSignal
  on_output?: (stream: "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<ModelCharacterization> {
  const modeled_requirements = input.characterization.requirements.filter(
    ({ support }) => support.status === "modeled",
  )
  const pages = [
    ...new Set(modeled_requirements.flatMap((requirement) => requirement.sources.map(({ page }) => page))),
  ].sort((left, right) => left - right)
  if (pages.length === 0) throw new Error("Modeled requirements do not cite a datasheet page")
  if (pages.length > MAX_MODEL_EVIDENCE_PAGES) {
    throw new Error(
      `Modeled requirements cite ${pages.length} pages; the retained-reference limit is ${MAX_MODEL_EVIDENCE_PAGES}`,
    )
  }
  const evidence_dir = join(input.workspace, "evidence")
  const evidence_metadata = await lstat(evidence_dir).catch(() => undefined)
  if (evidence_metadata && (!evidence_metadata.isDirectory() || evidence_metadata.isSymbolicLink())) {
    throw new Error("Model evidence output must be a real directory, not a symlink")
  }
  await mkdir(evidence_dir, { recursive: true })
  const render_workspace = await createStageWorkspace({
    prefix: "model-evidence-render",
    files: [{ source: input.datasheet_path, destination: "datasheet.pdf" }],
  })
  try {
    const rendered_evidence_dir = join(render_workspace.path, "evidence")
    await mkdir(rendered_evidence_dir, { recursive: true })
    for (const page of pages) {
      input.signal.throwIfAborted()
      const output_prefix = join(rendered_evidence_dir, `source-page-${page}`)
      try {
        await input.process_runner.run({
          command: [
            "pdftoppm",
            "-f",
            String(page),
            "-l",
            String(page),
            "-r",
            String(MODEL_EVIDENCE_DPI),
            "-png",
            "-singlefile",
            join(render_workspace.path, "datasheet.pdf"),
            output_prefix,
          ],
          command_label: `Render model evidence page ${page}`,
          cwd: render_workspace.path,
          signal: input.signal,
          wall_timeout_ms: 120_000,
          max_output_chars: 20_000,
          on_output: input.on_output,
        })
      } catch (error) {
        input.signal.throwIfAborted()
        throw new Error(
          `Modeled requirement cites PDF page ${page}, but the server could not render that page`,
          { cause: error },
        )
      }
    }
    await validateStageDirectory({
      root: rendered_evidence_dir,
      max_files: pages.length,
      max_total_bytes: MAX_RENDERED_EVIDENCE_BYTES,
      validate_file: validatePngArtifact,
    })
    await Promise.all(
      pages.map((page) =>
        promoteStageFile({
          workspace: render_workspace.path,
          source: join("evidence", `source-page-${page}.png`),
          destination_root: input.workspace,
          destination: join("evidence", `source-page-${page}.png`),
          max_bytes: 32 * 1024 * 1024,
          signal: input.signal,
        }),
      ),
    )
  } finally {
    await render_workspace.dispose().catch(() => undefined)
  }

  return {
    ...input.characterization,
    requirements: input.characterization.requirements.map((requirement) => {
      const cloned_reference_curve = requirement.reference_curve
        ? {
            ...requirement.reference_curve,
            points: requirement.reference_curve.points.map((point) => ({ ...point })),
          }
        : undefined
      if (requirement.support.status !== "modeled") {
        return {
          ...requirement,
          support: { ...requirement.support },
          conditions: { ...requirement.conditions },
          expected: { ...requirement.expected },
          ...(cloned_reference_curve ? { reference_curve: cloned_reference_curve } : {}),
          sources: requirement.sources.map((source) => ({ ...source })),
        }
      }
      const primary_page = requirement.sources[0]!.page
      const canonical_image = `evidence/source-page-${primary_page}.png`
      return {
        ...requirement,
        support: { ...requirement.support },
        conditions: { ...requirement.conditions },
        expected: { ...requirement.expected },
        ...(cloned_reference_curve
          ? { reference_curve: { ...cloned_reference_curve, image: canonical_image } }
          : {}),
        sources: requirement.sources.map((source) => ({
          ...source,
          image: `evidence/source-page-${source.page}.png`,
        })),
      }
    }),
    assumptions: [...input.characterization.assumptions],
    limitations: [...input.characterization.limitations],
  }
}
