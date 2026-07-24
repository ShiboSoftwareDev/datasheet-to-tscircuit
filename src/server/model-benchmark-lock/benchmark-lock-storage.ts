import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parseBenchmarkManifest, validateBenchmarkReferenceFiles } from "../model-scorer"
import { validateSimulationDefinitions } from "../model-simulation-validator"
import { BenchmarkLock, LockedFile } from "./types"
import { assertBenchmarkSourceContract, parseBenchmarkRecords } from "./assert-benchmark-source-contract"
import {
  assertEvidenceFile,
  getLockRoot,
  hashContent,
  isRecord,
  resolveWorkspaceFile,
} from "./benchmark-lock-paths"

interface ReadCurrentLockOptions {
  require_source_images?: boolean
}

type LockedFileContent = LockedFile & { content: Buffer }

function isPng(content: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  return content.length >= signature.length && signature.every((byte, index) => content[index] === byte)
}

export async function readCurrentLock(
  model_dir: string,
  options: ReadCurrentLockOptions = {},
): Promise<{
  benchmark_ids: string[]
  files: LockedFileContent[]
  warnings: string[]
}> {
  const manifest_text = await readFile(join(model_dir, "benchmarks.json"), "utf8")
  const manifest_value: unknown = JSON.parse(manifest_text)
  const manifest = parseBenchmarkManifest(manifest_value)
  const records = parseBenchmarkRecords(manifest_value)
  const exclusions_path = join(model_dir, "benchmark-exclusions.json")
  const exclusions_text = await readFile(exclusions_path, "utf8").catch(() => undefined)
  if (exclusions_text !== undefined) {
    const exclusions: unknown = JSON.parse(exclusions_text)
    if (!isRecord(exclusions) || exclusions.version !== 1 || !Array.isArray(exclusions.excluded)) {
      throw new Error("benchmark-exclusions.json must be a server-owned version 1 exclusion record")
    }
    const excluded_ids = exclusions.excluded.map((entry, index) => {
      if (
        !isRecord(entry) ||
        typeof entry.benchmark_id !== "string" ||
        !entry.benchmark_id.trim() ||
        !Array.isArray(entry.reasons) ||
        entry.reasons.length === 0 ||
        entry.reasons.some((reason) => typeof reason !== "string" || !reason.trim())
      ) {
        throw new Error(`benchmark-exclusions.json entry ${index + 1} is malformed`)
      }
      return entry.benchmark_id.trim()
    })
    if (new Set(excluded_ids).size !== excluded_ids.length) {
      throw new Error("benchmark-exclusions.json benchmark ids must be unique")
    }
    const draft: unknown = JSON.parse(await readFile(join(model_dir, "benchmark-draft.json"), "utf8"))
    if (!isRecord(draft) || !Array.isArray(draft.benchmarks)) {
      throw new Error("benchmark-exclusions.json requires the complete benchmark-draft.json inventory")
    }
    const draft_ids = draft.benchmarks.map((entry, index) => {
      if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
        throw new Error(`benchmark-draft.json benchmark ${index + 1} has no stable id`)
      }
      return entry.id.trim()
    })
    const executable_ids = new Set(records.map((record) => record.id))
    const expected_excluded_ids = draft_ids.filter((id) => !executable_ids.has(id)).sort()
    if (JSON.stringify(excluded_ids.sort()) !== JSON.stringify(expected_excluded_ids)) {
      throw new Error(
        "benchmark-exclusions.json must exactly explain every drafted benchmark omitted from the executable suite",
      )
    }
  }
  for (const record of records) {
    for (const series of record.series) {
      assertEvidenceFile(model_dir, series.reference_file)
      if (series.source_image) assertEvidenceFile(model_dir, series.source_image)
    }
    if (options.require_source_images && !record.source_image) {
      throw new Error(
        `Benchmark ${record.id} must declare source.image as evidence/figures/${record.id}.png for its exact datasheet graph crop`,
      )
    }
    if (record.source_image) assertEvidenceFile(model_dir, record.source_image)
  }
  const warnings = await validateBenchmarkReferenceFiles(model_dir, manifest)
  await validateSimulationDefinitions(
    model_dir,
    records.map((record) => record.id),
  )
  const benchmark_entries = await readdir(join(model_dir, "benchmarks")).catch(() => [])
  const benchmark_files = benchmark_entries.filter((entry) => entry.endsWith(".circuit.tsx")).sort()
  const expected_files = records.map((record) => `${record.id}.circuit.tsx`).sort()
  if (JSON.stringify(benchmark_files) !== JSON.stringify(expected_files)) {
    throw new Error("benchmarks.json and benchmarks/*.circuit.tsx must contain the same locked benchmark ids")
  }

  const paths = [
    "benchmarks.json",
    ...(exclusions_text === undefined ? [] : ["benchmark-exclusions.json"]),
    ...records.map((record) => join("benchmarks", `${record.id}.circuit.tsx`)),
    ...records.flatMap((record) => record.series.map((series) => series.reference_file)),
    ...records.flatMap((record) => (record.source_image ? [record.source_image] : [])),
    ...records.flatMap((record) =>
      record.series.flatMap((series) => (series.source_image ? [series.source_image] : [])),
    ),
  ]
  const unique_paths = [...new Set(paths)]
  const files = await Promise.all(
    unique_paths.map(async (file) => {
      const content = await readFile(resolveWorkspaceFile(model_dir, file))
      return { file, content, sha256: hashContent(content) }
    }),
  )
  for (const record of records) {
    const source_file = files.find((file) => file.file === join("benchmarks", `${record.id}.circuit.tsx`))
    if (!source_file) throw new Error(`Benchmark ${record.id} source is missing`)
    assertBenchmarkSourceContract(source_file.content.toString("utf8"), record)
    if (record.source_image) {
      const image = files.find((file) => file.file === record.source_image)?.content
      if (!image || !isPng(image)) {
        throw new Error(`Benchmark ${record.id} source.image must be a valid PNG graph crop`)
      }
    }
    const full_image = record.source_image
      ? files.find((file) => file.file === record.source_image)?.content
      : undefined
    const channel_image_labels = new Map<string, string>()
    for (const series of record.series) {
      if (!series.source_image) continue
      const image = files.find((file) => file.file === series.source_image)?.content
      if (!image || !isPng(image)) {
        throw new Error(
          `Benchmark ${record.id} series ${series.id} source_image must be a valid PNG channel crop`,
        )
      }
      const image_hash = hashContent(image)
      if (record.series.length > 1 && full_image && image_hash === hashContent(full_image)) {
        warnings.push(
          `Evidence quality: ${record.id}/${series.id} reuses the complete figure as its channel crop. The output remains available, but inspect the full figure because this channel image was not independently cropped.`,
        )
      }
      const previous_channel = channel_image_labels.get(image_hash)
      if (previous_channel) {
        warnings.push(
          `Evidence quality: ${record.id}/${series.id} and ${previous_channel} use the same channel image. The output remains available, but the individual channel evidence is duplicated.`,
        )
      } else {
        channel_image_labels.set(image_hash, `${record.id}/${series.id}`)
      }
    }
  }
  return {
    benchmark_ids: records.map((record) => record.id).sort(),
    files,
    warnings: [...new Set(warnings)],
  }
}

export async function writeTextAtomically(file_path: string, text: string): Promise<void> {
  await writeFileAtomically(file_path, text)
}

async function writeFileAtomically(file_path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file_path), { recursive: true })
  const temporary_path = `${file_path}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary_path, content)
  await rename(temporary_path, file_path)
}

export function parseLock(value: unknown): BenchmarkLock {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.locked_at !== "string" ||
    !Array.isArray(value.benchmark_ids) ||
    !value.benchmark_ids.every((id) => typeof id === "string") ||
    !Array.isArray(value.files) ||
    !value.files.every(
      (file) => isRecord(file) && typeof file.file === "string" && typeof file.sha256 === "string",
    )
  ) {
    throw new Error("The server-owned benchmark lock is invalid")
  }
  const generation = "generation" in value ? value.generation : 1
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
    throw new Error("The server-owned benchmark lock has an invalid generation")
  }
  return { ...(value as Omit<BenchmarkLock, "generation">), generation }
}

export async function writeLockSnapshots(input: {
  model_dir: string
  files: LockedFileContent[]
  generation: number
}): Promise<void> {
  const { model_dir, files, generation } = input
  const lock_root = getLockRoot(model_dir)
  const generation_root = join(lock_root, "snapshots", `generation-${String(generation).padStart(4, "0")}`)
  const current_root = join(lock_root, "snapshot")
  await rm(current_root, { recursive: true, force: true })
  await Promise.all(
    files.flatMap(({ file, content }) => [
      writeFileAtomically(join(generation_root, file), content),
      writeFileAtomically(join(current_root, file), content),
    ]),
  )
}
