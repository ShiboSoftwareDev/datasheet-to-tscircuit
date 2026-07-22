import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  SimulationBenchmarkVerification,
  SimulationValidationReport,
  VerifiedSimulationArtifact,
} from "./types"
import {
  getModelSimulationSourceSignature,
  getValidationRoot,
  hashText,
  readTrustedReport,
  resolveInside,
  writeTextAtomically,
} from "./simulation-validation-storage"
import { assertSafeBenchmarkId, isRecord } from "./parse-simulation-definition"
import { isCircuitJson } from "./get-circuit-build-diagnostics"
import { readSimulationDefinition } from "./simulation-definitions"

export async function writeSimulationValidationReport(
  model_dir: string,
  benchmarks: SimulationBenchmarkVerification[],
): Promise<void> {
  const report: SimulationValidationReport = {
    version: 2,
    generated_at: new Date().toISOString(),
    benchmarks,
  }
  const text = `${JSON.stringify(report, null, 2)}\n`
  await Promise.all([
    writeTextAtomically(join(getValidationRoot(model_dir), "simulation-validation.json"), text),
    writeTextAtomically(join(model_dir, "simulation-validation.json"), text),
  ])
}

export async function getVerifiedSimulationArtifact(
  model_dir: string,
  benchmark_id: string,
): Promise<VerifiedSimulationArtifact | undefined> {
  assertSafeBenchmarkId(benchmark_id)
  const report = await readTrustedReport(model_dir)
  const result = report?.benchmarks.find((candidate) => candidate.benchmark_id === benchmark_id)
  if (
    !result ||
    typeof result.passed !== "boolean" ||
    typeof result.generated_at !== "string" ||
    typeof result.source_file !== "string" ||
    typeof result.source_sha256 !== "string" ||
    typeof result.circuit_json_file !== "string" ||
    typeof result.circuit_json_sha256 !== "string"
  ) {
    return undefined
  }
  const trusted_root = getValidationRoot(model_dir)
  const circuit_path = resolveInside(trusted_root, result.circuit_json_file)
  const source_path = resolveInside(trusted_root, join("benchmarks", benchmark_id, "source.circuit.tsx"))
  if (!circuit_path || !source_path) return undefined
  const [circuit_text, code] = await Promise.all([
    readFile(circuit_path, "utf8"),
    readFile(source_path, "utf8"),
  ])
  if (hashText(circuit_text) !== result.circuit_json_sha256 || hashText(code) !== result.source_sha256) {
    return undefined
  }
  const circuit_json: unknown = JSON.parse(circuit_text)
  if (!isCircuitJson(circuit_json)) return undefined

  let result_text: string | undefined
  let result_file: string | undefined
  let result_texts: Record<string, string> | undefined
  let result_files: Record<string, string> | undefined
  if (result.passed) {
    if (typeof result.verified_result_file !== "string" || typeof result.sha256 !== "string") {
      return undefined
    }
    const result_path = resolveInside(trusted_root, result.verified_result_file)
    if (!result_path) return undefined
    result_text = await readFile(result_path, "utf8")
    if (hashText(result_text) !== result.sha256) return undefined
    result_file = `results/verified/${benchmark_id}.csv`
    if (Array.isArray(result.verified_result_files) && result.verified_result_files.length > 0) {
      const entries = await Promise.all(
        result.verified_result_files.map(async (series) => {
          if (
            !isRecord(series) ||
            typeof series.series_id !== "string" ||
            typeof series.file !== "string" ||
            typeof series.sha256 !== "string"
          )
            return undefined
          const series_path = resolveInside(trusted_root, series.file)
          if (!series_path) return undefined
          const text = await readFile(series_path, "utf8")
          if (hashText(text) !== series.sha256) return undefined
          return {
            series_id: series.series_id,
            text,
            file: `results/verified/${benchmark_id}/${series.series_id}.csv`,
          }
        }),
      )
      if (entries.some((entry) => !entry)) return undefined
      result_texts = Object.fromEntries(entries.map((entry) => [entry!.series_id, entry!.text]))
      result_files = Object.fromEntries(entries.map((entry) => [entry!.series_id, entry!.file]))
      const primary = result.verified_result_files.find(
        (series) => series.file === result.verified_result_file,
      )
      if (primary) result_file = result_files[primary.series_id]
    }
  } else if (
    result.status === "building" &&
    typeof result.partial_result_file === "string" &&
    typeof result.partial_sha256 === "string"
  ) {
    const result_path = resolveInside(trusted_root, result.partial_result_file)
    if (!result_path) return undefined
    result_text = await readFile(result_path, "utf8")
    if (hashText(result_text) !== result.partial_sha256) return undefined
    result_file = `results/partial/${benchmark_id}.csv`
    if (Array.isArray(result.partial_result_files) && result.partial_result_files.length > 0) {
      const entries = await Promise.all(
        result.partial_result_files.map(async (series) => {
          if (
            !isRecord(series) ||
            typeof series.series_id !== "string" ||
            typeof series.file !== "string" ||
            typeof series.sha256 !== "string"
          )
            return undefined
          const series_path = resolveInside(trusted_root, series.file)
          if (!series_path) return undefined
          const text = await readFile(series_path, "utf8")
          if (hashText(text) !== series.sha256) return undefined
          return {
            series_id: series.series_id,
            text,
            file: `results/partial/${benchmark_id}/${series.series_id}.csv`,
          }
        }),
      )
      if (entries.some((entry) => !entry)) return undefined
      result_texts = Object.fromEntries(entries.map((entry) => [entry!.series_id, entry!.text]))
      result_files = Object.fromEntries(entries.map((entry) => [entry!.series_id, entry!.file]))
      const primary = result.partial_result_files.find((series) => series.file === result.partial_result_file)
      if (primary) result_file = result_files[primary.series_id]
    }
  }
  return {
    benchmark_id,
    passed: result.passed,
    generated_at: result.generated_at,
    source_file: result.source_file,
    source_signature: result.source_signature,
    code,
    circuit_json,
    result_file,
    result_text,
    result_files,
    result_texts,
    error_message: result.error_message,
    status: result.status ?? (result.passed ? "passed" : "failed"),
  }
}

export async function getVerifiedResultFile(
  model_dir: string,
  benchmark_id: string,
): Promise<string | undefined> {
  const artifact = await getVerifiedSimulationArtifact(model_dir, benchmark_id)
  return artifact?.passed ? artifact.result_file : undefined
}

export async function getVerifiedResultFiles(
  model_dir: string,
  benchmark_id: string,
): Promise<Record<string, string> | undefined> {
  const artifact = await getVerifiedSimulationArtifact(model_dir, benchmark_id)
  return artifact?.passed ? artifact.result_files : undefined
}

export async function hasCompleteVerifiedSimulationReport(model_dir: string): Promise<boolean> {
  const report = await readTrustedReport(model_dir)
  if (!report || report.benchmarks.length === 0) return false
  if (report.benchmarks.some((benchmark) => !benchmark.passed)) return false
  const manifest: unknown = await readFile(join(model_dir, "benchmarks.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
  if (!isRecord(manifest) || !Array.isArray(manifest.benchmarks)) return false
  const benchmark_ids = manifest.benchmarks.flatMap((benchmark) =>
    isRecord(benchmark) && typeof benchmark.id === "string" ? [benchmark.id] : [],
  )
  if (
    benchmark_ids.length !== manifest.benchmarks.length ||
    JSON.stringify([...benchmark_ids].sort()) !==
      JSON.stringify(report.benchmarks.map((benchmark) => benchmark.benchmark_id).sort())
  ) {
    return false
  }
  const definitions_are_current = await Promise.all(
    benchmark_ids.map((benchmark_id) =>
      readSimulationDefinition(model_dir, benchmark_id)
        .then(() => true)
        .catch(() => false),
    ),
  )
  if (definitions_are_current.some((is_current) => !is_current)) return false
  const artifacts = await Promise.all(
    report.benchmarks.map(async (benchmark) => {
      const [artifact, current_signature] = await Promise.all([
        getVerifiedSimulationArtifact(model_dir, benchmark.benchmark_id).catch(() => undefined),
        getModelSimulationSourceSignature(model_dir, benchmark.benchmark_id).catch(() => undefined),
      ])
      return artifact?.source_signature && artifact.source_signature === current_signature
        ? artifact
        : undefined
    }),
  )
  return artifacts.every(
    (artifact) =>
      artifact?.passed === true &&
      (Boolean(artifact.result_text) ||
        Boolean(artifact.result_texts && Object.keys(artifact.result_texts).length)),
  )
}
