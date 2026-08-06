import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  createStageWorkspace,
  promoteStageDirectory,
  validatePngArtifact,
  validateStageDirectory,
} from "../infrastructure/artifacts"
import type { ProcessRunner } from "../infrastructure/process"
import { foundObservedGraphs, type ReferenceGraphObservation } from "./reference-graph-observation"
import { assertPngContainsVisibleContent, decodeModelEvidencePng } from "./model-evidence-pages"

const MAX_FOUND_REFERENCE_BYTES = 96 * 1024 * 1024

/** Renders the exact source crops retained by Find Reference Graphs; no numeric curve state is created. */
export async function materializeFoundReferenceEvidence(input: {
  workspace: string
  datasheet_path: string
  observation: ReferenceGraphObservation
  process_runner: ProcessRunner
  signal: AbortSignal
  on_output?: (stream: "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<string> {
  const references = foundObservedGraphs(input.observation)
  if (references.length === 0) throw new Error("Find Reference Graphs produced no displayable references")
  const render_workspace = await createStageWorkspace({
    prefix: "model-found-reference-evidence",
    files: [{ source: input.datasheet_path, destination: "datasheet.pdf" }],
  })
  try {
    const figures_dir = join(render_workspace.path, "evidence", "figures")
    await mkdir(figures_dir, { recursive: true })
    for (const graph of references) {
      input.signal.throwIfAborted()
      const crop = graph.crop
      await input.process_runner.run({
        command: [
          "pdftoppm",
          "-f",
          String(crop.page),
          "-l",
          String(crop.page),
          "-r",
          String(crop.render_dpi),
          "-x",
          String(crop.x_px),
          "-y",
          String(crop.y_px),
          "-W",
          String(crop.width_px),
          "-H",
          String(crop.height_px),
          "-png",
          "-singlefile",
          join(render_workspace.path, "datasheet.pdf"),
          join(figures_dir, graph.graph_id),
        ],
        command_label: `Render found reference graph ${graph.graph_id}`,
        cwd: render_workspace.path,
        signal: input.signal,
        wall_timeout_ms: 120_000,
        max_output_chars: 20_000,
        on_output: input.on_output,
      })
      const path = join(figures_dir, `${graph.graph_id}.png`)
      const dimensions = await decodeModelEvidencePng(path, graph.graph_id)
      if (dimensions.width !== crop.width_px || dimensions.height !== crop.height_px) {
        throw new Error(
          `Found reference crop ${graph.graph_id} rendered as ${dimensions.width}x${dimensions.height}; expected ${crop.width_px}x${crop.height_px}`,
        )
      }
      await assertPngContainsVisibleContent(path, graph.graph_id)
    }
    await validateStageDirectory({
      root: figures_dir,
      max_files: references.length,
      max_total_bytes: MAX_FOUND_REFERENCE_BYTES,
      validate_file: validatePngArtifact,
    })
    await promoteStageDirectory({
      workspace: render_workspace.path,
      source: join("evidence", "figures"),
      destination_root: input.workspace,
      destination: join("evidence", "figures"),
      max_files: references.length,
      max_total_bytes: MAX_FOUND_REFERENCE_BYTES,
      validate_file: validatePngArtifact,
      signal: input.signal,
    })
  } finally {
    await render_workspace.dispose().catch(() => undefined)
  }
  return join(input.workspace, "evidence")
}
