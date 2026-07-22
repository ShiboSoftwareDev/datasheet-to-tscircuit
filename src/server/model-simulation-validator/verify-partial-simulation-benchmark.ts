import { readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { SimulationBenchmarkVerification } from "./types"
import { assertSafeBenchmarkId } from "./parse-simulation-definition"
import { readSimulationDefinitions } from "./simulation-definitions"
import { isCircuitJson } from "./get-circuit-build-diagnostics"
import { extractSimulationResultSeries, parseSimulationOutput } from "./extract-simulation-result-points"
import {
  assertCanonicalDutSimulation,
  assertNoSyntheticBenchmarkChannel,
  assertSenseResistorMeasurement,
  assertSimulationProbeExists,
} from "./assert-canonical-dut-simulation"
import {
  getModelSimulationSourceSignature,
  getValidationRoot,
  hashText,
  toCsv,
  writeArtifactCopies,
  writeTextAtomically,
} from "./simulation-validation-storage"

export async function verifyPartialSimulationBenchmark(input: {
  model_dir: string
  benchmark_id: string
  source_signature?: string
  circuit_json_paths: Array<{ path: string }>
}): Promise<SimulationBenchmarkVerification> {
  const generated_at = new Date().toISOString()
  assertSafeBenchmarkId(input.benchmark_id)
  const definitions = await readSimulationDefinitions(input.model_dir, input.benchmark_id)
  const source_path = join(input.model_dir, "benchmarks", `${input.benchmark_id}.circuit.tsx`)
  const supplied_paths = [...input.circuit_json_paths]
  if (supplied_paths.length === 0) throw new Error("partial validation has no simulator output")

  if (supplied_paths.length !== 1) {
    throw new Error("transient waveform validation requires exactly one simulator output")
  }
  const paths = supplied_paths
  const [source_text, model_source, ...circuit_texts] = await Promise.all([
    readFile(source_path, "utf8"),
    readFile(join(input.model_dir, "model.lib"), "utf8"),
    ...paths.map(({ path }) => readFile(path, "utf8")),
  ])
  const circuit_jsons: unknown[] = circuit_texts.map((text) => JSON.parse(text))
  if (circuit_jsons.some((json) => !isCircuitJson(json))) {
    throw new Error("partial simulation did not produce valid Circuit JSON")
  }
  const parsed = circuit_jsons.map((json) => parseSimulationOutput(json))
  const errors = [...new Set(parsed.flatMap(({ errors }) => errors))]
  if (errors.length > 0) throw new Error(errors.join("; "))
  assertNoSyntheticBenchmarkChannel(model_source)
  for (const circuit of circuit_jsons) {
    for (const definition of definitions) {
      if (definition.role === "response") {
        assertCanonicalDutSimulation({
          circuit_json: circuit as AnyCircuitElement[],
          model_source,
          probe_name: definition.probe_name,
          dut_spice_node: definition.dut_spice_node!,
          sense_resistor: definition.sense_resistor,
          scale: definition.scale,
          unit: definition.unit,
        })
      } else if (definition.sense_resistor) {
        assertSenseResistorMeasurement({
          circuit_json: circuit as AnyCircuitElement[],
          probe_name: definition.probe_name,
          sense_resistor: definition.sense_resistor,
          scale: definition.scale,
          unit: definition.unit,
        })
      } else {
        assertSimulationProbeExists({
          circuit_json: circuit as AnyCircuitElement[],
          probe_name: definition.probe_name,
        })
      }
    }
  }

  const result_series = extractSimulationResultSeries(circuit_jsons[0], definitions)
  const legacy = definitions.length === 1 && definitions[0]?.series_id === "result"
  const files = definitions.map((definition) => {
    const text = toCsv(result_series[definition.series_id]!)
    const trusted_result_file = legacy
      ? join(getValidationRoot(input.model_dir), "partial-results", `${input.benchmark_id}.csv`)
      : join(
          getValidationRoot(input.model_dir),
          "partial-results",
          input.benchmark_id,
          `${definition.series_id}.csv`,
        )
    const diagnostic_result_file = legacy
      ? join(input.model_dir, "results", "partial", `${input.benchmark_id}.csv`)
      : join(input.model_dir, "results", "partial", input.benchmark_id, `${definition.series_id}.csv`)
    return { definition, text, trusted_result_file, diagnostic_result_file }
  })
  await Promise.all(
    files.flatMap((file) => [
      writeTextAtomically(file.trusted_result_file, file.text),
      writeTextAtomically(file.diagnostic_result_file, file.text),
    ]),
  )
  const primary = files.find((file) => file.definition.role === "response")!
  const artifact = await writeArtifactCopies({
    model_dir: input.model_dir,
    benchmark_id: input.benchmark_id,
    circuit_text: circuit_texts[0]!,
    source_text,
  })
  return {
    benchmark_id: input.benchmark_id,
    passed: false,
    status: "building",
    generated_at,
    ...artifact,
    source_signature:
      input.source_signature ??
      (await getModelSimulationSourceSignature(input.model_dir, input.benchmark_id)),
    partial_result_file: relative(getValidationRoot(input.model_dir), primary.trusted_result_file),
    partial_sha256: hashText(primary.text),
    ...(legacy
      ? {}
      : {
          partial_result_files: files.map((file) => ({
            series_id: file.definition.series_id,
            file: relative(getValidationRoot(input.model_dir), file.trusted_result_file),
            sha256: hashText(file.text),
          })),
        }),
  }
}
