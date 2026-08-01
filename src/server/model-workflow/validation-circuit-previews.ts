import type { AnyCircuitElement } from "circuit-json"
import { join } from "node:path"
import { isCircuitJson } from "../component-circuit-json"
import { createStageWorkspace } from "../infrastructure/artifacts"
import type { ProcessRunner } from "../infrastructure/process"
import { buildTscircuitSource } from "../infrastructure/tscircuit"
import { renderValidationCaseTsx, type GeneratedModel } from "../modeling"
import type { ValidationPlan } from "../spice-validation"

const MAX_CONCURRENT_PREVIEW_BUILDS = 3

export interface ValidationCircuitPreviewBuild {
  circuit_json_by_case: Readonly<Record<string, AnyCircuitElement[] | undefined>>
  errors_by_case: Readonly<Record<string, string | undefined>>
}

async function buildOnePreview(input: {
  model_dir: string
  validation_case: ValidationPlan["cases"][number]
  generated: GeneratedModel
  tsci_bin: string
  process_runner: ProcessRunner
  signal: AbortSignal
  append: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<{ case_id: string; circuit_json?: AnyCircuitElement[]; error?: string }> {
  const case_id = input.validation_case.id
  const workspace = await createStageWorkspace({
    prefix: `model-preview-${case_id}`,
    files: [
      { source: join(input.model_dir, "package.json"), required: false },
      { source: join(input.model_dir, "tsconfig.json"), required: false },
      { source: join(input.model_dir, "tscircuit.config.json"), required: false },
      { source: join(input.model_dir, "tscircuit.config.ts"), required: false },
    ],
  })
  try {
    input.signal.throwIfAborted()
    const source_file = `${case_id}.circuit.tsx`
    await Bun.write(
      join(workspace.path, source_file),
      renderValidationCaseTsx({
        validation_case: input.validation_case,
        manifest: input.generated.manifest,
        model_source: input.generated.source,
        model_card: input.generated.card,
      }),
    )
    await input.append("system", `Building validation TSX preview ${case_id}\n`)
    const build = await buildTscircuitSource({
      workspace: workspace.path,
      source_file,
      output_stem: case_id,
      tsci_bin: input.tsci_bin,
      process_runner: input.process_runner,
      signal: input.signal,
      build_args: ["--disable-pcb"],
      ignored_error_types: ["source_pin_must_be_connected_error"],
      on_output: (stream, message) => input.append(stream, message),
    })
    const error = build.errors.length > 0 ? build.errors.join("; ") : undefined
    if (error) await input.append("stderr", `Validation TSX preview ${case_id}: ${error}\n`)
    if (error) return { case_id, error }
    if (!isCircuitJson(build.circuit_json)) {
      const empty_error = "tsci produced no renderable Circuit JSON"
      await input.append("stderr", `Validation TSX preview ${case_id}: ${empty_error}\n`)
      return { case_id, error: empty_error }
    }
    return { case_id, circuit_json: build.circuit_json }
  } catch (error) {
    input.signal.throwIfAborted()
    const message = error instanceof Error ? error.message : String(error)
    await input.append("stderr", `Validation TSX preview ${case_id} could not be built: ${message}\n`)
    return { case_id, error: message }
  } finally {
    await workspace.dispose().catch(() => undefined)
  }
}

/** Builds display-only schematic Circuit JSON without exposing validation cases to the model agent. */
export async function buildValidationCircuitPreviews(input: {
  model_dir: string
  plan: ValidationPlan
  generated: GeneratedModel
  tsci_bin: string
  process_runner: ProcessRunner
  signal: AbortSignal
  append: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<ValidationCircuitPreviewBuild> {
  const results: Array<Awaited<ReturnType<typeof buildOnePreview>> | undefined> = new Array(
    input.plan.cases.length,
  )
  let next_index = 0
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_PREVIEW_BUILDS, input.plan.cases.length) },
    async () => {
      while (true) {
        const index = next_index
        next_index += 1
        const validation_case = input.plan.cases[index]
        if (!validation_case) return
        results[index] = await buildOnePreview({ ...input, validation_case })
      }
    },
  )
  await Promise.all(workers)
  return {
    circuit_json_by_case: Object.fromEntries(
      results.flatMap((result) => (result ? [[result.case_id, result.circuit_json]] : [])),
    ),
    errors_by_case: Object.fromEntries(
      results.flatMap((result) => (result ? [[result.case_id, result.error]] : [])),
    ),
  }
}
