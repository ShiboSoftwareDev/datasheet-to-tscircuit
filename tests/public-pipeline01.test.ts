import { expect, test } from "bun:test"
import { parsePublicPipelineSnapshot, projectPublicPipelineSnapshot } from "@/server/pipeline"
import type { PipelineRunSnapshot } from "@/shared/pipeline-types"

type Outputs = {
  generate: { secret_source: string }
  validate: { passed: boolean }
}

function privateSnapshot(): PipelineRunSnapshot<Outputs> {
  return {
    run_id: "private-run-id",
    pipeline_id: "component_generation",
    status: "failed",
    sequence: 7,
    started_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:02.000Z",
    stage_results: {
      generate: {
        stage_id: "generate",
        status: "completed",
        output: { secret_source: "private model source" },
        debug_dir: "/Users/example/jobs/job-1/.pipeline/stages/01-generate",
        artifacts: [
          {
            artifact_id: "source",
            path: "/Users/example/jobs/job-1/candidate.tsx",
            hash: { algorithm: "sha256", value: "a".repeat(64) },
            size_bytes: 20,
            media_type: "text/typescript",
            role: "candidate",
          },
        ],
        diagnostics: [],
        metrics: { candidate_bytes: 20 },
        started_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-01T00:00:01.000Z",
        duration_ms: 1_000,
      },
      validate: {
        stage_id: "validate",
        status: "failed",
        debug_dir: "/Users/example/jobs/job-1/.pipeline/stages/02-validate",
        artifacts: [],
        diagnostics: [],
        metrics: {},
        error: {
          code: "validation_failed",
          severity: "error",
          message: "Invalid artifact at /Users/example/jobs/job-1/candidate.tsx",
          stage_id: "validate",
          operation: "validate_candidate",
          entity_refs: [],
          artifact_refs: [{ path: "/Users/example/jobs/job-1/candidate.tsx" }],
          cause_chain: [
            {
              name: "Error",
              message: "parser failed in /private/tmp/isolated-candidate",
              stack: "private stack",
            },
          ],
          hint: "Inspect /Users/example/jobs/job-1/.pipeline/stages/02-validate/error.json",
          retryable: false,
        },
        started_at: "2026-01-01T00:00:01.000Z",
        completed_at: "2026-01-01T00:00:02.000Z",
        duration_ms: 1_000,
      },
    },
  }
}

test("public pipeline projection keeps trace state while stripping private stage data", () => {
  const projected = projectPublicPipelineSnapshot({
    snapshot: privateSnapshot(),
    artifact_root: "/Users/example/jobs/job-1",
    private_roots: ["/private/tmp/isolated-candidate"],
  })
  const serialized = JSON.stringify(projected)

  expect(projected.pipeline_id).toBe("component_generation")
  expect(projected.stage_results.generate.debug_ref).toBe(".pipeline/stages/01-generate")
  expect(projected.stage_results.validate.error?.message).toBe(
    "Invalid artifact at <workspace>/candidate.tsx",
  )
  expect(projected.stage_results.validate.error?.hint).toBe(
    "Inspect <workspace>/.pipeline/stages/02-validate/error.json",
  )
  expect(serialized).not.toContain("private-run-id")
  expect(serialized).not.toContain("secret_source")
  expect(serialized).not.toContain("candidate_bytes")
  expect(serialized).not.toContain("artifact_id")
  expect(serialized).not.toContain("cause_chain")
  expect(serialized).not.toContain("/Users/")
  expect(serialized).not.toContain("/private/")
  expect(parsePublicPipelineSnapshot(projected)).toEqual(projected)
})

test("public pipeline parser rejects path escapes and structurally unsafe stages", () => {
  const projected = projectPublicPipelineSnapshot({
    snapshot: privateSnapshot(),
    artifact_root: "/Users/example/jobs/job-1",
  })
  const unsafe_absolute = structuredClone(projected)
  unsafe_absolute.stage_results.generate!.debug_ref = "/private/tmp/stage"
  expect(parsePublicPipelineSnapshot(unsafe_absolute)).toBeUndefined()

  const unsafe_traversal = structuredClone(projected)
  unsafe_traversal.stage_results.generate!.debug_ref = ".pipeline/../../candidate"
  expect(parsePublicPipelineSnapshot(unsafe_traversal)).toBeUndefined()

  const mismatched_stage = structuredClone(projected)
  mismatched_stage.stage_results.generate!.stage_id = "different-stage"
  expect(parsePublicPipelineSnapshot(mismatched_stage)).toBeUndefined()

  const failed_without_error = JSON.parse(JSON.stringify(projected)) as Record<string, unknown>
  const stages = failed_without_error.stage_results as Record<string, Record<string, unknown>>
  Reflect.deleteProperty(stages.validate!, "error")
  expect(parsePublicPipelineSnapshot(failed_without_error)).toBeUndefined()
})
