import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createStageWorkspace, promoteStageDirectory, promoteStageFile } from "../../infrastructure/artifacts"
import type { ModelRunStore } from "../../model-run-store"
import { type GeneratedModel, type ModelContract, projectModelUi } from "../../modeling"
import type { ValidationPlan, ValidationRunResult } from "../../spice-validation"
import { writeViewerValidationArtifacts } from "../viewer-validation-artifacts"
import { writeJson } from "./basic"

function createCandidateDiagnostics(input: {
  plan: ValidationPlan
  result: ValidationRunResult
  generated: GeneratedModel
  preview_generation: string
  projection: ReturnType<typeof projectModelUi>
  circuit_build_errors_by_case?: Readonly<Record<string, string | undefined>>
  viewer_errors_by_case?: Readonly<Record<string, string | undefined>>
  circuit_json_by_case?: Parameters<typeof projectModelUi>[0]["circuit_json_by_case"]
}) {
  const result_by_case = new Map(input.result.cases.map((entry) => [entry.case_id, entry]))
  return {
    version: 1,
    status: input.projection.validation.all_passed ? "passed" : "failed",
    model_revision: input.generated.manifest.revision,
    preview_generation: input.preview_generation,
    errors: input.result.errors,
    cases: input.plan.cases.map((validation_case) => {
      const result = result_by_case.get(validation_case.id)
      const preview = input.projection.selected_previews[validation_case.id]
      return {
        case_id: validation_case.id,
        analysis: validation_case.analysis.type,
        server_status: result?.status ?? "not_run",
        circuit_build_status: preview?.circuit_preview?.build_status ?? "not_built",
        viewer_status: preview?.circuit_preview?.analog_simulation_status ?? "not_available",
        comparison_status: preview?.reference_preview?.result_status ?? "unverified",
        diagnostics: [
          ...(result?.errors ?? []).map((error) => ({ source: "server_validation", ...error })),
          ...(result?.series.flatMap((series) =>
            series.errors.map((error) => ({
              source: "server_comparison",
              observation_id: series.observation_id,
              ...error,
            })),
          ) ?? []),
          ...(input.circuit_build_errors_by_case?.[validation_case.id]
            ? [
                {
                  source: "tscircuit_build",
                  message: input.circuit_build_errors_by_case[validation_case.id],
                },
              ]
            : []),
          ...(input.viewer_errors_by_case?.[validation_case.id]
            ? [
                {
                  source: "tscircuit_viewer",
                  message: input.viewer_errors_by_case[validation_case.id],
                },
              ]
            : []),
        ],
        artifacts: {
          preview: `cases/${validation_case.id}.preview.json`,
          tsx: `cases/${validation_case.id}.circuit.tsx`,
          ...(input.circuit_json_by_case?.[validation_case.id]
            ? { circuit_json: `cases/${validation_case.id}.circuit.json` }
            : {}),
          validation_results: "validation-results.json",
          validation_plan: "validation-plan.json",
        },
      }
    }),
  }
}

export async function persistCandidateValidationUi(input: {
  plan: ValidationPlan
  result: ValidationRunResult
  generated: GeneratedModel
  contract: ModelContract
  immutable_artifact_dir: string
  preview_generation: string
  circuit_json_by_case?: Parameters<typeof projectModelUi>[0]["circuit_json_by_case"]
  circuit_build_errors_by_case?: Parameters<typeof projectModelUi>[0]["circuit_build_errors_by_case"]
  viewer_validation_by_case?: Parameters<typeof projectModelUi>[0]["viewer_validation_by_case"]
  viewer_errors_by_case?: Parameters<typeof projectModelUi>[0]["viewer_errors_by_case"]
}): Promise<ReturnType<typeof projectModelUi>> {
  const updated_at = new Date().toISOString()
  const projection = projectModelUi({
    plan: input.plan,
    result: input.result,
    manifest: input.generated.manifest,
    model_source: input.generated.source,
    model_card: input.generated.card,
    updated_at,
    circuit_json_by_case: input.circuit_json_by_case,
    circuit_build_errors_by_case: input.circuit_build_errors_by_case,
    viewer_validation_by_case: input.viewer_validation_by_case,
    viewer_errors_by_case: input.viewer_errors_by_case,
    contract: input.contract,
    validation_artifact_state: "candidate",
    preview_generation: input.preview_generation,
  })
  const cases_dir = join(input.immutable_artifact_dir, "cases")
  const diagnostics = createCandidateDiagnostics({
    plan: input.plan,
    result: input.result,
    generated: input.generated,
    preview_generation: input.preview_generation,
    projection,
    circuit_build_errors_by_case: input.circuit_build_errors_by_case,
    viewer_errors_by_case: input.viewer_errors_by_case,
    circuit_json_by_case: input.circuit_json_by_case,
  })
  await Promise.all([
    mkdir(input.immutable_artifact_dir, { recursive: true }),
    mkdir(cases_dir, { recursive: true }),
  ])
  await Promise.all([
    writeJson(join(input.immutable_artifact_dir, "validation-results.json"), input.result),
    writeJson(join(input.immutable_artifact_dir, "validation-plan.json"), input.plan),
    writeJson(join(input.immutable_artifact_dir, "model-ui.json"), projection),
    writeJson(join(input.immutable_artifact_dir, "candidate-diagnostics.json"), diagnostics),
    ...Object.entries(projection.selected_previews).flatMap(([case_id, preview]) => {
      const writes: Promise<unknown>[] = [writeJson(join(cases_dir, `${case_id}.preview.json`), preview)]
      if (preview.circuit_preview?.code) {
        writes.push(Bun.write(join(cases_dir, `${case_id}.circuit.tsx`), preview.circuit_preview.code))
      }
      return writes
    }),
  ])
  await writeViewerValidationArtifacts({
    validation_dir: input.immutable_artifact_dir,
    plan: input.plan,
    generated: input.generated,
    circuit_json_by_case: input.circuit_json_by_case ?? {},
  })
  return projection
}

/**
 * Publishes a recoverable live-view bundle only after every case preview has
 * been written. This is deliberately separate from accepted publication.
 */
export async function projectCandidateValidationUi(input: {
  model_run_store: ModelRunStore
  model_run_id: string
  model_dir: string
  immutable_artifact_dir: string
  evidence_dir: string
  revision: string
  projection: ReturnType<typeof projectModelUi>
  signal: AbortSignal
}): Promise<void> {
  input.signal.throwIfAborted()
  const preview_generation = input.projection.validation.preview_generation
  if (!preview_generation || !/^[a-zA-Z0-9_-]{16,200}$/.test(preview_generation)) {
    throw new Error("Candidate UI projection is missing a safe immutable preview generation")
  }
  if (
    input.projection.validation.artifact_state !== "candidate" ||
    !/^[a-f0-9]{16}$/.test(input.revision) ||
    input.projection.validation.model_revision !== input.revision
  ) {
    throw new Error("Candidate UI projection revision does not match its immutable candidate bundle")
  }
  for (const [case_id, preview] of Object.entries(input.projection.selected_previews)) {
    if (
      preview.artifact_identity?.preview_generation !== preview_generation ||
      preview.artifact_identity.model_revision !== input.revision
    ) {
      throw new Error(`Candidate UI projection ${case_id} does not match its immutable artifact identity`)
    }
  }
  const workspace = await createStageWorkspace({
    prefix: "model-current-preview",
    files: [
      {
        source: join(input.immutable_artifact_dir, "validation-results.json"),
        destination: "bundle/validation-results.json",
      },
      {
        source: join(input.immutable_artifact_dir, "validation-plan.json"),
        destination: "bundle/validation-plan.json",
      },
      {
        source: join(input.immutable_artifact_dir, "model-ui.json"),
        destination: "bundle/model-ui.json",
      },
      {
        source: join(input.immutable_artifact_dir, "viewer-validation.json"),
        destination: "bundle/viewer-validation.json",
      },
      {
        source: join(input.immutable_artifact_dir, "candidate-diagnostics.json"),
        destination: "bundle/candidate-diagnostics.json",
      },
    ],
    directories: [
      { source: join(input.immutable_artifact_dir, "cases"), destination: "bundle/cases" },
      { source: input.evidence_dir, destination: "bundle/evidence", required: false },
    ],
  })
  try {
    await writeJson(join(workspace.path, "bundle", "candidate-preview.json"), {
      version: 1,
      model_run_id: input.model_run_id,
      invocation_id: input.model_run_store.getModelRun(input.model_run_id)?.current_invocation_id,
      revision: input.revision,
      preview_generation,
      updated_at: new Date().toISOString(),
    })
    await promoteStageDirectory({
      workspace: workspace.path,
      source: "bundle",
      destination_root: input.model_dir,
      destination: join("current-previews", preview_generation),
      max_files: 512,
      max_total_bytes: 128 * 1024 * 1024,
      signal: input.signal,
    })
    await writeJson(join(workspace.path, "current-preview.json"), {
      version: 1,
      model_run_id: input.model_run_id,
      invocation_id: input.model_run_store.getModelRun(input.model_run_id)?.current_invocation_id,
      revision: input.revision,
      preview_generation,
      updated_at: new Date().toISOString(),
    })
    await promoteStageFile({
      workspace: workspace.path,
      source: "current-preview.json",
      destination_root: input.model_dir,
      signal: input.signal,
    })
  } finally {
    await workspace.dispose().catch(() => undefined)
  }
  input.signal.throwIfAborted()
  const first_option = input.projection.preview_options[0]
  const first_preview = first_option
    ? input.projection.selected_previews[first_option.benchmark_id]
    : undefined
  input.model_run_store.projectCandidateValidation(input.model_run_id, {
    validation: input.projection.validation,
    preview_options: input.projection.preview_options,
    previews: {
      circuit_preview: first_preview?.circuit_preview,
      reference_preview: first_preview?.reference_preview,
    },
  })
}
