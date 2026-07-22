import { mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { clearVerifiedSimulationResults } from "../model-simulation-validator"
import { listCandidateModelFiles } from "./model-checkpoint"

export async function hasCompletedSetup(model_dir: string): Promise<boolean> {
  return Bun.file(join(model_dir, "setup-complete.json")).exists()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function validateCompletedSetup(model_dir: string): Promise<void> {
  const [setup, draft] = await Promise.all(
    ["setup-complete.json", "benchmark-draft.json"].map(async (file) => {
      const text = await readFile(join(model_dir, file), "utf8").catch(() => undefined)
      if (text === undefined) throw new Error(`Untimed setup did not create ${file}`)
      return JSON.parse(text) as unknown
    }),
  )
  if (!isRecord(setup) || setup.version !== 2) {
    throw new Error("setup-complete.json must use version 2 for complete time-graph inventory validation")
  }
  if (!isRecord(draft) || draft.version !== 2 || !Array.isArray(draft.benchmarks)) {
    throw new Error("benchmark-draft.json must use version 2 and contain benchmarks[]")
  }
  const omitted = draft.reviewed_time_graphs_not_drafted
  if (Array.isArray(omitted) && omitted.length > 0) {
    throw new Error("benchmark-draft.json explicitly omits reviewed time-domain graphs")
  }
  if (!Array.isArray(draft.figure_inventory) || draft.figure_inventory.length === 0) {
    throw new Error("benchmark-draft.json must inventory every reviewed graph in figure_inventory[]")
  }
  const draft_ids = draft.benchmarks.map((benchmark, index) => {
    if (!isRecord(benchmark) || typeof benchmark.id !== "string" || !benchmark.id.trim()) {
      throw new Error(`benchmark-draft.json benchmark ${index + 1} has no stable id`)
    }
    return benchmark.id.trim()
  })
  if (new Set(draft_ids).size !== draft_ids.length) {
    throw new Error("benchmark-draft.json benchmark ids must be unique")
  }
  const inventoried_time_ids = draft.figure_inventory.flatMap((figure, index) => {
    if (!isRecord(figure) || (figure.x_axis !== "time" && figure.x_axis !== "static")) {
      throw new Error(`benchmark-draft.json figure_inventory item ${index + 1} must classify x_axis`)
    }
    if (figure.x_axis !== "time") return []
    if (figure.status !== "drafted" || typeof figure.benchmark_id !== "string") {
      throw new Error(
        `Every reviewed time-domain graph must be drafted; figure_inventory item ${index + 1} is omitted`,
      )
    }
    return [figure.benchmark_id.trim()]
  })
  if (
    new Set(inventoried_time_ids).size !== inventoried_time_ids.length ||
    JSON.stringify([...inventoried_time_ids].sort()) !== JSON.stringify([...draft_ids].sort())
  ) {
    throw new Error(
      "benchmark-draft.json figure_inventory time graphs and benchmarks[] must have the same unique benchmark ids",
    )
  }
  if (setup.draft_benchmark_count !== draft_ids.length) {
    throw new Error("setup-complete.json draft_benchmark_count does not match benchmark-draft.json")
  }
}

export async function validateFinalizedBenchmarksMatchDraft(model_dir: string): Promise<void> {
  const [draft, manifest] = await Promise.all(
    ["benchmark-draft.json", "benchmarks.json"].map(async (file) => {
      const text = await readFile(join(model_dir, file), "utf8").catch(() => undefined)
      if (text === undefined) throw new Error(`Benchmark finalization did not create ${file}`)
      return JSON.parse(text) as unknown
    }),
  )
  if (!isRecord(draft) || !Array.isArray(draft.benchmarks)) {
    throw new Error("benchmark-draft.json has no benchmark list")
  }
  if (!isRecord(manifest) || !Array.isArray(manifest.benchmarks)) {
    throw new Error("benchmarks.json has no benchmark list")
  }
  const readIds = (entries: unknown[], file: string): string[] =>
    entries.map((entry, index) => {
      if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
        throw new Error(`${file} benchmark ${index + 1} has no stable id`)
      }
      return entry.id.trim()
    })
  const draft_ids = readIds(draft.benchmarks, "benchmark-draft.json").sort()
  const manifest_ids = readIds(manifest.benchmarks, "benchmarks.json").sort()
  if (JSON.stringify(draft_ids) !== JSON.stringify(manifest_ids)) {
    throw new Error(
      `Finalized benchmark ids must exactly match the complete time-graph draft; drafted [${draft_ids.join(
        ", ",
      )}], finalized [${manifest_ids.join(", ")}]`,
    )
  }
}

export async function findPrematureRefinementArtifacts(model_dir: string): Promise<string[]> {
  const canonical_files = [
    "model.lib",
    "model-manifest.json",
    "component-with-model.circuit.tsx",
    "iteration-history.json",
    "model-card.md",
    "validation-report.json",
  ]
  const present = await Promise.all(
    canonical_files.map(async (file) =>
      (await Bun.file(join(model_dir, file)).exists()) ? file : undefined,
    ),
  )
  const candidate_files = await listCandidateModelFiles(join(model_dir, "candidates"))
  return [...present.filter((file): file is string => Boolean(file)), ...candidate_files]
}

export async function clearIncompleteBenchmarkFinalization(model_dir: string): Promise<void> {
  await Promise.all([
    rm(join(model_dir, "benchmarks.json"), { force: true }),
    rm(join(model_dir, "benchmarks"), { recursive: true, force: true }),
  ])
  await mkdir(join(model_dir, "benchmarks"), { recursive: true })
}

export async function clearRefinementArtifacts(model_dir: string): Promise<void> {
  await clearVerifiedSimulationResults(model_dir)
  await Promise.all([
    ...[
      "model.lib",
      "model-manifest.json",
      "component-with-model.circuit.tsx",
      "iteration-history.json",
      "model-card.md",
      "validation-report.json",
      "validation-feedback.md",
    ].map((file) => rm(join(model_dir, file), { force: true })),
    ...["candidates", "results/champion"].map((directory) =>
      rm(join(model_dir, directory), { recursive: true, force: true }),
    ),
  ])
  await mkdir(join(model_dir, "results", "champion"), { recursive: true })
}
