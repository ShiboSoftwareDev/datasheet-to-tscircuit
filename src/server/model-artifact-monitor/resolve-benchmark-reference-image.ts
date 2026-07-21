import { readFile, realpath, stat } from "node:fs/promises"
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path"
import { listFiles } from "./read-reference-preview"

interface BenchmarkImageSource {
  page?: number
  figure?: string
  image?: string
  source_image?: string
}

interface BenchmarkImageRecord {
  source?: BenchmarkImageSource
  reference_image?: string
  source_image?: string
}

export interface BenchmarkReferenceImage {
  file_path: string
  content_type: string
}

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readImageSource(value: unknown): BenchmarkImageSource | undefined {
  if (!isRecord(value)) return undefined
  return {
    page:
      typeof value.page === "number" && Number.isInteger(value.page) && value.page > 0
        ? value.page
        : undefined,
    figure: typeof value.figure === "string" ? value.figure : undefined,
    image: typeof value.image === "string" ? value.image : undefined,
    source_image: typeof value.source_image === "string" ? value.source_image : undefined,
  }
}

async function readBenchmark(
  model_dir: string,
  benchmark_id: string,
): Promise<BenchmarkImageRecord | undefined> {
  for (const file_name of ["benchmarks.json", "benchmark-draft.json"]) {
    const manifest: unknown = await readFile(join(model_dir, file_name), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => undefined)
    if (!isRecord(manifest) || !Array.isArray(manifest.benchmarks)) continue
    const raw_benchmark = manifest.benchmarks.find((value) => isRecord(value) && value.id === benchmark_id)
    if (!isRecord(raw_benchmark)) return undefined
    return {
      source: readImageSource(raw_benchmark.source),
      reference_image:
        typeof raw_benchmark.reference_image === "string" ? raw_benchmark.reference_image : undefined,
      source_image: typeof raw_benchmark.source_image === "string" ? raw_benchmark.source_image : undefined,
    }
  }
  return undefined
}

function isInsideDirectory(directory: string, file_path: string): boolean {
  const relative_path = relative(directory, file_path)
  return relative_path !== "" && !relative_path.startsWith("..") && !isAbsolute(relative_path)
}

async function resolveExplicitImage(
  model_dir: string,
  evidence_dir: string,
  raw_path: string | undefined,
): Promise<string | undefined> {
  if (!raw_path?.trim()) return undefined
  const evidence_real_path = await realpath(evidence_dir).catch(() => undefined)
  if (!evidence_real_path) return undefined
  const candidates = [resolve(model_dir, raw_path), resolve(evidence_dir, raw_path)]
  for (const candidate_path of candidates) {
    const file_path = await realpath(candidate_path).catch(() => undefined)
    if (
      !file_path ||
      !isInsideDirectory(evidence_real_path, file_path) ||
      !IMAGE_CONTENT_TYPES[extname(file_path).toLowerCase()]
    ) {
      continue
    }
    const file_stat = await stat(file_path).catch(() => undefined)
    if (file_stat?.isFile() && file_stat.size > 0) return file_path
  }
  return undefined
}

function figureKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^figure/, "fig")
    .replace(/[^a-z0-9]/g, "")
}

function chooseBestMatch(files: string[]): string | undefined {
  return files.sort((first, second) => first.length - second.length || first.localeCompare(second))[0]
}

function findFigureImage(files: string[], figure: string | undefined): string | undefined {
  if (!figure?.trim()) return undefined
  const expected_key = figureKey(figure)
  const keyed_files = files.map((file_path) => ({
    file_path,
    key: figureKey(basename(file_path, extname(file_path))),
  }))
  const exact_matches = keyed_files.filter((candidate) => candidate.key === expected_key)
  if (exact_matches.length > 0) return chooseBestMatch(exact_matches.map(({ file_path }) => file_path))
  const suffixed_matches = keyed_files.filter((candidate) => candidate.key.endsWith(expected_key))
  return suffixed_matches.length === 1 ? suffixed_matches[0]?.file_path : undefined
}

function findPageImage(files: string[], page: number | undefined): string | undefined {
  if (!page) return undefined
  const exact_page_pattern = new RegExp(`^(?:datasheet[-_ ]*)?page[-_ ]*0*${page}$`, "i")
  const exact_matches = files.filter((file_path) =>
    exact_page_pattern.test(basename(file_path, extname(file_path))),
  )
  if (exact_matches.length > 0) return chooseBestMatch(exact_matches)

  const page_pattern = new RegExp(`(?:^|[-_ ])page[-_ ]*0*${page}(?:$|[-_ ])`, "i")
  const page_matches = files.filter((file_path) => page_pattern.test(basename(file_path, extname(file_path))))
  return page_matches.length === 1 ? page_matches[0] : undefined
}

export async function resolveBenchmarkReferenceImage(input: {
  model_dir: string
  benchmark_id: string
}): Promise<BenchmarkReferenceImage | undefined> {
  const benchmark = await readBenchmark(input.model_dir, input.benchmark_id)
  if (!benchmark) return undefined

  const evidence_dir = resolve(input.model_dir, "evidence")
  const explicit_paths = [
    benchmark.source?.image,
    benchmark.source?.source_image,
    benchmark.reference_image,
    benchmark.source_image,
  ]
  for (const raw_path of explicit_paths) {
    const file_path = await resolveExplicitImage(input.model_dir, evidence_dir, raw_path)
    if (file_path) {
      return { file_path, content_type: IMAGE_CONTENT_TYPES[extname(file_path).toLowerCase()]! }
    }
  }

  const image_files = (await listFiles(evidence_dir, "")).filter(
    (file_path) => IMAGE_CONTENT_TYPES[extname(file_path).toLowerCase()],
  )
  const file_path =
    findFigureImage(image_files, benchmark.source?.figure) ??
    findPageImage(image_files, benchmark.source?.page)
  if (!file_path) return undefined
  return { file_path, content_type: IMAGE_CONTENT_TYPES[extname(file_path).toLowerCase()]! }
}
