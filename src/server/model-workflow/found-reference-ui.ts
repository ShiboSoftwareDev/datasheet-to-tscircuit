import { rm } from "node:fs/promises"
import { join } from "node:path"
import { createStageWorkspace, promoteStageDirectory } from "../infrastructure/artifacts"
import type { ModelRunStore } from "../model-run-store"
import { foundObservedGraphs, type ReferenceGraphObservation } from "./reference-graph-observation"
import { writeJson } from "./stage-helpers"

const sourceImage = (graph_id: string) => `evidence/figures/${graph_id}.png`

/** Publishes source crops only. Numeric comparison series belong to Create Comparison Graphs. */
export async function projectFoundReferencesUi(input: {
  model_run_store: ModelRunStore
  model_run_id: string
  model_dir: string
  observation: ReferenceGraphObservation
  evidence_dir: string
  signal: AbortSignal
}): Promise<void> {
  input.signal.throwIfAborted()
  const references = foundObservedGraphs(input.observation)
  if (references.length === 0) throw new Error("Find Reference Graphs produced no displayable references")
  const workspace = await createStageWorkspace({
    prefix: "model-found-references",
    files: [],
    directories: [{ source: input.evidence_dir, destination: "bundle/evidence" }],
  })
  try {
    const bundle = join(workspace.path, "bundle")
    const updated_at = new Date().toISOString()
    await writeJson(join(bundle, "reference-index.json"), {
      version: 1,
      references: references.map((graph) => ({
        benchmark_id: graph.graph_id,
        requirement_ids: [graph.graph_id],
        sources: [
          {
            page: graph.page,
            figure: graph.locator,
            image: sourceImage(graph.graph_id),
          },
        ],
      })),
    })
    await promoteStageDirectory({
      workspace: workspace.path,
      source: "bundle",
      destination_root: input.model_dir,
      destination: "found-references",
      max_files: 256,
      max_total_bytes: 96 * 1024 * 1024,
      signal: input.signal,
    })
    // A Find-only rerun invalidates comparison output copied from the source job.
    // Keep the persisted workspace consistent with the live store projection.
    await rm(join(input.model_dir, "current-preview"), { recursive: true, force: true })
    input.model_run_store.projectFoundReferences(input.model_run_id, {
      found_references: references.map((graph) => ({
        reference_id: graph.graph_id,
        title: graph.locator,
        source_file: sourceImage(graph.graph_id),
        page: graph.page,
        figure: graph.locator,
        x_axis_label: "Time",
        x_axis_unit: "s",
        updated_at,
      })),
    })
  } finally {
    await workspace.dispose().catch(() => undefined)
  }
}
