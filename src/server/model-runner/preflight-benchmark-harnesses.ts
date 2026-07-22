import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { JobLogStream } from "@/shared/job-types"
import { parseTypicalApplicationPlan } from "../job-runner"
import { parseBenchmarkManifest, resolveWorkspaceFile } from "../model-scorer/parse-benchmark-manifest"
import {
  getBenchmarkRangeCoverageError,
  readCsvPoints,
  scoreSeriesPoints,
} from "../model-scorer/score-single-model-benchmark"
import {
  assertCanonicalDutSimulation,
  assertSenseResistorMeasurement,
  extractSimulationResultPoints,
} from "../model-simulation-validator"
import { parseSimulationOutput } from "../model-simulation-validator/extract-simulation-result-points"
import { parseSimulationDefinition } from "../model-simulation-validator/parse-simulation-definition"
import { writeServerIntegratedComponent } from "./attach-model-to-generated-component"
import {
  getBenchmarkApplicationErrors,
  getBenchmarkApplicationPlan,
  getRequiredPowerPinLabels,
  getStubComponentPins,
} from "./get-benchmark-application-plan"
import { listModelBenchFiles } from "./list-model-bench-files"
import { ModelInfrastructureError, type ModelRunnerContext } from "./stream-model-process"
import {
  executeValidationBuild,
  getValidationConcurrency,
  runValidationTaskPool,
  type ValidationBuildResult,
} from "./validate-champion"

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function getRequiredPowerPreflightProbeName(power_pin_label: string): string {
  return `SERVER_PREFLIGHT_POWER_${power_pin_label.toUpperCase()}`
}

export function getRequiredPowerProbeContractErrors(source: string, power_pin_labels: string[]): string[] {
  return [...new Set(power_pin_labels)].flatMap((label) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) return []
    const probe_name = getRequiredPowerPreflightProbeName(label)
    const tag_pattern = new RegExp(
      `<voltageprobe\\b(?=[^>]*\\bname=["']${escapeRegExp(probe_name)}["'])(?=[^>]*\\bconnectsTo=["']\\.DUT\\s*>\\s*\\.${escapeRegExp(label)}["'])[^>]*>`,
      "i",
    )
    return tag_pattern.test(source)
      ? []
      : [
          `benchmark must probe required-power pin ${label} with voltageprobe ${probe_name} connected directly to .DUT > .${label}`,
        ]
  })
}

export function getUnpoweredRequiredPinErrors(circuit_json: unknown, probe_names: string[]): string[] {
  if (probe_names.length === 0) return []
  const { graphs } = parseSimulationOutput(circuit_json)
  return probe_names.flatMap((probe_name) => {
    const graph = graphs.find((candidate) => candidate.name === probe_name)
    if (!graph) return [`required-power preflight produced no ${probe_name} waveform`]
    const peak_magnitude = Math.max(...graph.voltage_levels.map(Math.abs))
    return peak_magnitude < 0.05
      ? [`required-power stimulus ${probe_name} remained effectively unpowered (peak ${peak_magnitude} V)`]
      : []
  })
}

export async function preflightBenchmarkHarnesses(input: {
  model_run_id: string
  job_id: string
  job_dir: string
  model_dir: string
  signal: AbortSignal
  context: ModelRunnerContext
  append: (stream: JobLogStream, message: string) => Promise<void>
}): Promise<void> {
  const temporary_component = join(input.model_dir, "component-with-model.circuit.tsx")
  const saved_root = join(input.model_dir, ".benchmark-harness-preflight")
  const benchmark_files = await listModelBenchFiles(input.model_dir)
  const benchmark_manifest = parseBenchmarkManifest(
    JSON.parse(await readFile(join(input.model_dir, "benchmarks.json"), "utf8")),
  )
  const benchmarks_by_id = new Map(
    benchmark_manifest.benchmarks.map((benchmark) => [benchmark.id, benchmark]),
  )
  const generated_directories = benchmark_files.map((benchmark_file) =>
    join(input.job_dir, "dist", "spice", "benchmarks", benchmark_file.replace(/\.circuit\.tsx$/i, "")),
  )
  if (await Bun.file(temporary_component).exists()) {
    throw new Error("A model wrapper exists before benchmark simulation preflight")
  }
  const component_source = await readFile(join(input.model_dir, "component.circuit.tsx"), "utf8")
  const component_circuit_json = input.context.job_store.getJob(input.job_id)?.circuit_json
  const power_pin_labels = getRequiredPowerPinLabels(component_circuit_json)
  const power_probe_names = power_pin_labels.map(getRequiredPowerPreflightProbeName)
  const pins = getStubComponentPins({ component_circuit_json, component_source })
  const model_source = `.SUBCKT SERVER_BENCHMARK_STUB ${pins.map((pin) => pin.spice_node).join(" ")}\nRREF STUB_REF 0 1G\n${pins
    .map((pin, index) => `RSTUB${index + 1} ${pin.spice_node} STUB_REF 1G`)
    .join("\n")}\n.ENDS SERVER_BENCHMARK_STUB\n`
  await writeServerIntegratedComponent({
    model_dir: input.model_dir,
    manifest: {
      version: 1,
      part_number: "SERVER_BENCHMARK_STUB",
      dialect: "portable",
      entry_name: "SERVER_BENCHMARK_STUB",
      model_file: "model.lib",
      revision: "preflight",
      simulator: "ngspice",
      generated_at: new Date().toISOString(),
      pins,
    },
    model_source,
  })
  try {
    const application_plan_path = join(input.model_dir, "typical-application-plan.json")
    const parsed_application_plan = (await Bun.file(application_plan_path).exists())
      ? parseTypicalApplicationPlan(JSON.parse(await readFile(application_plan_path, "utf8")))
      : undefined
    const benchmark_application_plan =
      parsed_application_plan?.availability === "documented"
        ? getBenchmarkApplicationPlan(parsed_application_plan)
        : undefined
    await input.append(
      "system",
      `Running one server-owned stub-model simulation for each of ${benchmark_files.length} provisional benchmark harness(es) before locking…\n`,
    )
    const results = new Map<string, ValidationBuildResult>()
    await runValidationTaskPool({
      tasks: benchmark_files,
      concurrency: getValidationConcurrency(),
      signal: input.signal,
      run: async (benchmark_file) => {
        const benchmark_id = benchmark_file.replace(/\.circuit\.tsx$/i, "")
        const benchmark_source_path = join(input.model_dir, "benchmarks", benchmark_file)
        const power_probe_contract_errors = getRequiredPowerProbeContractErrors(
          await readFile(benchmark_source_path, "utf8"),
          power_pin_labels,
        )
        if (power_probe_contract_errors.length > 0) {
          results.set(benchmark_file, {
            exit_code: 1,
            failure_kind: "benchmark_structure",
            error_message: power_probe_contract_errors.join("; "),
          })
          return
        }
        let result = await executeValidationBuild({
          benchmark_file,
          run: {
            run_id: "preflight",
            source_path: benchmark_source_path,
            generated_path: join(input.job_dir, "dist", "spice", "benchmarks", benchmark_id, "circuit.json"),
            saved_path: join(saved_root, benchmark_id, "circuit.json"),
          },
          model_dir: input.model_dir,
          signal: input.signal,
          tsci_bin: input.context.tsci_bin,
          append: input.append,
        })
        if (result.exit_code === 0 && result.path && benchmark_application_plan) {
          const application_errors = await getBenchmarkApplicationErrors(
            benchmark_application_plan,
            result.path,
          )
          if (application_errors.length > 0) {
            result = {
              ...result,
              exit_code: 1,
              failure_kind: "benchmark_structure",
              error_message: `datasheet application topology mismatch: ${application_errors.join("; ")}`,
            }
          }
        }
        if (result.exit_code === 0 && result.path) {
          try {
            const benchmark = benchmarks_by_id.get(benchmark_id)
            if (!benchmark) throw new Error(`benchmarks.json has no ${benchmark_id} benchmark`)
            const circuit_json: unknown = JSON.parse(await readFile(result.path, "utf8"))
            for (const series of benchmark.series) {
              const definition = parseSimulationDefinition(series.simulation, {
                role: series.role,
                quantity: series.quantity,
              })
              if (series.role === "response" && definition.sense_resistor) {
                assertCanonicalDutSimulation({
                  circuit_json: circuit_json as import("circuit-json").AnyCircuitElement[],
                  model_source,
                  probe_name: definition.probe_name,
                  dut_spice_node: definition.dut_spice_node!,
                  sense_resistor: definition.sense_resistor,
                  scale: definition.scale,
                  unit: series.unit,
                })
              } else if (definition.sense_resistor) {
                assertSenseResistorMeasurement({
                  circuit_json: circuit_json as import("circuit-json").AnyCircuitElement[],
                  probe_name: definition.probe_name,
                  sense_resistor: definition.sense_resistor,
                  scale: definition.scale,
                  unit: series.unit,
                })
              }
              const reference_points = await readCsvPoints(
                resolveWorkspaceFile(input.model_dir, series.reference_file),
              )
              const result_points = extractSimulationResultPoints(circuit_json, definition)
              const coverage_error = getBenchmarkRangeCoverageError({
                reference_points,
                result_points,
                x_scale: benchmark.x_scale,
              })
              if (coverage_error) throw new Error(`${series.id}: ${coverage_error}`)
              if (series.role === "stimulus") {
                const stimulus_score = scoreSeriesPoints({
                  series,
                  reference_points,
                  result_points,
                  x_scale: benchmark.x_scale,
                })
                if (!stimulus_score.passed) {
                  const reference_values = reference_points.map((point) => point.y)
                  const result_values = result_points.map((point) => point.y)
                  const reference_range = `${Math.min(...reference_values)}..${Math.max(...reference_values)}`
                  const simulated_range = `${Math.min(...result_values)}..${Math.max(...result_values)}`
                  throw new Error(
                    `${series.id} harness stimulus does not match its digitized channel${
                      stimulus_score.error_message
                        ? `: ${stimulus_score.error_message}`
                        : ` (NRMSE ${stimulus_score.normalized_rmse}, max ${stimulus_score.normalized_max_error})`
                    }; reference range ${reference_range} ${series.unit}, simulated range ${simulated_range} ${series.unit}`,
                  )
                }
              }
            }
            const power_errors = getUnpoweredRequiredPinErrors(circuit_json, power_probe_names)
            if (power_errors.length > 0) throw new Error(power_errors.join("; "))
          } catch (error) {
            result = {
              ...result,
              exit_code: 1,
              failure_kind: "benchmark_structure",
              error_message: `benchmark waveform preflight failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            }
          }
        }
        results.set(benchmark_file, result)
      },
    })
    if (input.signal.aborted) throw new Error("Benchmark simulation preflight was cancelled")
    const infrastructure_failures = [...results.entries()].filter(
      ([, result]) => result.failure_kind === "infrastructure",
    )
    if (infrastructure_failures.length > 0) {
      throw new ModelInfrastructureError(
        `Benchmark simulation preflight infrastructure failed: ${infrastructure_failures
          .map(([file, result]) => `${file}: ${result.error_message ?? "unknown infrastructure error"}`)
          .join(" | ")}`,
      )
    }
    const failures = benchmark_files.flatMap((benchmark_file) => {
      const result = results.get(benchmark_file)
      return !result || result.exit_code !== 0 || !result.path
        ? [
            `${benchmark_file}: ${
              result?.error_message ?? "stub-model simulation did not produce Circuit JSON"
            }`,
          ]
        : []
    })
    if (failures.length > 0) {
      throw new Error(`Benchmark simulation preflight failed: ${failures.join(" | ")}`)
    }
    await input.append("system", "Every provisional benchmark harness completed stub-model simulation.\n")
  } finally {
    await Promise.all([
      rm(temporary_component, { force: true }),
      rm(saved_root, { recursive: true, force: true }),
      ...generated_directories.map((directory) => rm(directory, { recursive: true, force: true })),
    ])
  }
}
