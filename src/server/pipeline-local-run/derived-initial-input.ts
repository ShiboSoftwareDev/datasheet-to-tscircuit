import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { PipelineTaskInputEnvelope } from "@/shared/pipeline-types"
import {
  loadPipelineTaskInputBundle,
  type PipelineTaskInputBundle,
  retainPipelineTaskInputFiles,
} from "../pipeline"

export interface DerivedInitialInputBundle {
  readonly bundle: PipelineTaskInputBundle
  cleanup(): Promise<void>
}

interface InitialInputContract {
  pipelineId: "typical_application" | "spice_generation"
  taskId: "extract_application_evidence" | "find_reference_graphs"
  excludedRoots: string[]
  modelRunId?: string
}

async function deriveInitialInputBundle(input: {
  sourceJobId: string
  sourceJobDir: string
  localRunsRoot: string
  useOpenai: boolean
  contract: InitialInputContract
  additionalInstructions?: string
}): Promise<DerivedInitialInputBundle> {
  await mkdir(input.localRunsRoot, { recursive: true })
  const bundleRoot = await mkdtemp(join(input.localRunsRoot, ".derived-initial-input-"))
  const inputDir = join(bundleRoot, "stages", input.contract.taskId)
  const inputPath = join(inputDir, "input.json")
  try {
    await mkdir(inputDir, { recursive: true })
    const inputFiles = await retainPipelineTaskInputFiles({
      root_dir: input.sourceJobDir,
      debug_dir: inputDir,
      objects_dir: join(bundleRoot, "input-objects"),
      excluded_roots: input.contract.excludedRoots,
    })
    const envelope: PipelineTaskInputEnvelope = {
      version: 2,
      kind: "pipeline_task_input",
      pipeline_id: input.contract.pipelineId,
      task_id: input.contract.taskId,
      run_id: input.contract.modelRunId ?? input.sourceJobId,
      execution_context: {
        job_id: input.sourceJobId,
        job_dir: input.sourceJobDir,
        use_openai: input.useOpenai,
        invocation_id: crypto.randomUUID(),
        ...(input.contract.modelRunId
          ? {
              model_run_id: input.contract.modelRunId,
              model_dir: join(input.sourceJobDir, "spice"),
            }
          : {}),
        ...(input.additionalInstructions ? { additional_instructions: input.additionalInstructions } : {}),
      },
      depends_on: [],
      dependency_statuses: {},
      dependency_outputs: {},
      input_files: inputFiles,
    }
    await writeFile(inputPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8")
    const bundle = await loadPipelineTaskInputBundle(inputPath)
    return {
      bundle,
      cleanup: () => rm(bundleRoot, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(bundleRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/** Captures the component-only boundary for a never-run application pipeline. */
export function deriveApplicationInputBundle(input: {
  sourceJobId: string
  sourceJobDir: string
  localRunsRoot: string
  useOpenai: boolean
  additionalInstructions?: string
}): Promise<DerivedInitialInputBundle> {
  return deriveInitialInputBundle({
    ...input,
    contract: {
      pipelineId: "typical_application",
      taskId: "extract_application_evidence",
      excludedRoots: ["spice"],
    },
  })
}

/** Captures the published component/application boundary for a never-run SPICE pipeline. */
export function deriveSpiceInputBundle(input: {
  sourceJobId: string
  sourceJobDir: string
  localRunsRoot: string
  modelRunId: string
  useOpenai: boolean
  additionalInstructions?: string
}): Promise<DerivedInitialInputBundle> {
  return deriveInitialInputBundle({
    ...input,
    contract: {
      pipelineId: "spice_generation",
      taskId: "find_reference_graphs",
      excludedRoots: ["spice"],
      modelRunId: input.modelRunId,
    },
  })
}
