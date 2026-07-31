import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path"
import { readVerifiedPublicationArtifact, resolveAcceptedModelPublication } from "./model-publication"

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? listFiles(path) : [path]
    }),
  )
  return nested.flat()
}

interface BenchmarkImageSource {
  page?: number
  figure?: string
  image?: string
}

interface BenchmarkImageRecord {
  sources: BenchmarkImageSource[]
}

export type BenchmarkReferenceImage =
  | { file_path: string; file_name: string; content_type: string; bytes?: never }
  | { bytes: Uint8Array<ArrayBuffer>; file_name: string; content_type: string; file_path?: never }

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseBenchmark(validation_plan: unknown, benchmark_id: string): BenchmarkImageRecord | undefined {
  if (isRecord(validation_plan) && Array.isArray(validation_plan.cases)) {
    const validation_case = validation_plan.cases.find(
      (value) => isRecord(value) && value.id === benchmark_id,
    )
    if (isRecord(validation_case) && Array.isArray(validation_case.observations)) {
      const sources = validation_case.observations.flatMap((observation) => {
        if (!isRecord(observation) || !isRecord(observation.evidence)) return []
        const metadata = isRecord(observation.evidence.metadata) ? observation.evidence.metadata : undefined
        return [
          {
            page:
              typeof observation.evidence.page === "number" &&
              Number.isInteger(observation.evidence.page) &&
              observation.evidence.page > 0
                ? observation.evidence.page
                : undefined,
            figure: typeof metadata?.figure === "string" ? metadata.figure : undefined,
            image: typeof observation.evidence.image === "string" ? observation.evidence.image : undefined,
          },
        ]
      })
      return { sources }
    }
  }
  return undefined
}

async function readBenchmark(
  model_dir: string,
  benchmark_id: string,
): Promise<BenchmarkImageRecord | undefined> {
  const validation_plan: unknown = await readFile(join(model_dir, "validation-plan.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
  return parseBenchmark(validation_plan, benchmark_id)
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

function explicitPublishedImageCandidates(raw_path: string | undefined): string[] {
  const trimmed = raw_path?.trim()
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\") || trimmed.includes("\0")) return []
  const segments = trimmed.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return []
  return trimmed.startsWith("evidence/") ? [trimmed] : [`evidence/${trimmed}`]
}

export async function resolveBenchmarkReferenceImage(input: {
  job_id: string
  model_dir: string
  benchmark_id: string
}): Promise<BenchmarkReferenceImage | undefined> {
  const publication = await resolveAcceptedModelPublication(input.model_dir, input.job_id)
  if (publication) {
    const plan_bytes = await readVerifiedPublicationArtifact({
      publication,
      bundle: "accepted_model",
      relative_path: "validation-plan.json",
      max_bytes: 8 * 1024 * 1024,
    })
    const benchmark = parseBenchmark(JSON.parse(new TextDecoder().decode(plan_bytes)), input.benchmark_id)
    if (!benchmark) return undefined
    const image_files = Object.keys(publication.accepted_bundle_manifest.files).filter(
      (relative_path) =>
        relative_path.startsWith("evidence/") &&
        Boolean(IMAGE_CONTENT_TYPES[extname(relative_path).toLowerCase()]),
    )
    const explicit_match = benchmark.sources
      .flatMap((source) => explicitPublishedImageCandidates(source.image))
      .find((relative_path) => image_files.includes(relative_path))
    const relative_path =
      explicit_match ??
      benchmark.sources
        .map((source) => findFigureImage(image_files, source.figure))
        .find((match) => match !== undefined) ??
      benchmark.sources
        .map((source) => findPageImage(image_files, source.page))
        .find((match) => match !== undefined)
    if (!relative_path) return undefined
    const content_type = IMAGE_CONTENT_TYPES[extname(relative_path).toLowerCase()]
    if (!content_type) return undefined
    return {
      bytes: await readVerifiedPublicationArtifact({
        publication,
        bundle: "accepted_model",
        relative_path,
        max_bytes: 32 * 1024 * 1024,
      }),
      file_name: basename(relative_path),
      content_type,
    }
  }
  const model_dir = input.model_dir
  const benchmark = await readBenchmark(model_dir, input.benchmark_id)
  if (!benchmark) return undefined

  const evidence_dir = resolve(model_dir, "evidence")
  const explicit_paths = benchmark.sources.map((source) => source.image)
  for (const raw_path of explicit_paths) {
    const file_path = await resolveExplicitImage(model_dir, evidence_dir, raw_path)
    if (file_path) {
      const content_type = IMAGE_CONTENT_TYPES[extname(file_path).toLowerCase()]
      if (content_type) return { file_path, file_name: basename(file_path), content_type }
    }
  }

  const image_files = (await listFiles(evidence_dir)).filter(
    (file_path) => IMAGE_CONTENT_TYPES[extname(file_path).toLowerCase()],
  )
  const file_path =
    benchmark.sources
      .map((source) => findFigureImage(image_files, source.figure))
      .find((match) => match !== undefined) ??
    benchmark.sources
      .map((source) => findPageImage(image_files, source.page))
      .find((match) => match !== undefined)
  if (!file_path) return undefined
  const content_type = IMAGE_CONTENT_TYPES[extname(file_path).toLowerCase()]
  return content_type ? { file_path, file_name: basename(file_path), content_type } : undefined
}
