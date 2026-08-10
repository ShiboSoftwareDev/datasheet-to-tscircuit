import { expect, test } from "bun:test"
import { APPLICATION_PIPELINE, COMPONENT_PIPELINE } from "@/server/component-workflow"
import { MODEL_PIPELINE } from "@/server/model-workflow"
import { mergeDebugSnapshot } from "@/server/pipeline-debug-api"
import type { PublicPipelineSnapshot } from "@/shared/job-types"
import { PIPELINE_DEBUG_CATALOG } from "@/shared/pipeline-debug"

test("the debug catalog exactly matches the three authoritative pipeline registries", () => {
  const definitions = [COMPONENT_PIPELINE, APPLICATION_PIPELINE, MODEL_PIPELINE]
  expect(PIPELINE_DEBUG_CATALOG.map(({ pipeline_id }) => String(pipeline_id))).toEqual(
    definitions.map(({ pipeline_id }) => String(pipeline_id)),
  )
  for (const definition of definitions) {
    const catalog = PIPELINE_DEBUG_CATALOG.find(({ pipeline_id }) => pipeline_id === definition.pipeline_id)
    const catalog_stages: string[] | undefined = catalog
      ? catalog.stages.map((stage_id) => String(stage_id))
      : undefined
    const definition_stages: string[] = definition.stages.map(({ id }) => String(id))
    expect(catalog_stages).toEqual(definition_stages)
  }
})

test("an isolated rerun preserves retained inputs for untouched steps", () => {
  const previous: PublicPipelineSnapshot = {
    pipeline_id: "component_generation",
    status: "completed",
    sequence: 12,
    started_at: "2026-08-05T08:00:00.000Z",
    updated_at: "2026-08-05T08:01:00.000Z",
    stage_results: {
      extract_evidence: {
        stage_id: "extract_evidence",
        status: "completed",
        debug_ref: "runs/component_generation/first/.pipeline/stages/01-extract_evidence",
      },
      generate_component: {
        stage_id: "generate_component",
        status: "completed",
        debug_ref: "runs/component_generation/first/.pipeline/stages/02-generate_component",
      },
    },
  }
  const isolated: PublicPipelineSnapshot = {
    ...previous,
    status: "running",
    sequence: 3,
    started_at: "2026-08-05T09:00:00.000Z",
    updated_at: "2026-08-05T09:00:01.000Z",
    stage_results: {
      extract_evidence: {
        stage_id: "extract_evidence",
        status: "skipped",
        debug_ref: "runs/component_generation/debug/.pipeline/stages/01-extract_evidence",
      },
      generate_component: {
        stage_id: "generate_component",
        status: "running",
        debug_ref: "runs/component_generation/debug/.pipeline/stages/02-generate_component",
      },
    },
  }

  const merged = mergeDebugSnapshot(previous, isolated, new Set(["generate_component"]))

  expect(merged.status).toBe("running")
  expect(merged.stage_results.extract_evidence.debug_ref).toBe(
    "runs/component_generation/first/.pipeline/stages/01-extract_evidence",
  )
  expect(merged.stage_results.generate_component.debug_ref).toBe(
    "runs/component_generation/debug/.pipeline/stages/02-generate_component",
  )
})
