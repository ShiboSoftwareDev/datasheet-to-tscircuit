import { readFile } from "node:fs/promises"
import type { ModelProgressPhase } from "@/shared/job-types"
import type { PipelineArtifact } from "@/shared/pipeline-types"
import type { ModelRunStore } from "../../model-run-store"
import type { ModelContract } from "../../modeling"
import { createPipelineArtifact } from "../../pipeline"

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"))
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function modelArtifact(input: {
  id: string
  path: string
  media_type: string
  role: string
}): Promise<PipelineArtifact> {
  return createPipelineArtifact({
    artifact_id: input.id,
    path: input.path,
    media_type: input.media_type,
    role: input.role,
  })
}

export async function appendModelLog(
  store: ModelRunStore,
  model_run_id: string,
  stream: "system" | "stdout" | "stderr",
  message: string,
): Promise<void> {
  await store.appendLog(model_run_id, { stream, message })
}

export function updateModelProgress(input: {
  store: ModelRunStore
  model_run_id: string
  phase: ModelProgressPhase
  message: string
  iteration?: number
}): void {
  const current = input.store.getModelRun(input.model_run_id)
  input.store.updateProgress(input.model_run_id, {
    sequence: (current?.progress?.sequence ?? 0) + 1,
    phase: input.phase,
    message: input.message,
    updated_at: new Date().toISOString(),
    ...(input.iteration === undefined ? {} : { iteration: input.iteration }),
  })
}

export function modeledRequirementIds(contract: ModelContract): string[] {
  return contract.characterization.requirements.flatMap(({ requirement_id, support }) =>
    support.status === "modeled" ? [requirement_id] : [],
  )
}
