import { readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { JobLogStream } from "@/shared/job-types"
import ts from "typescript"
import { getCircuitBuildDiagnostics } from "../model-simulation-validator"
import { writeServerStructuralComponent } from "./attach-model-to-generated-component"
import { listModelBenchFiles } from "./list-model-bench-files"
import { ModelInfrastructureError, streamModelProcess } from "./stream-model-process"
import { captureProcessOutput, summarizeProcessFailure } from "./model-process-output"
import { getValidationConcurrency } from "./validate-champion"

export async function validateBenchmarkSources(input: {
  job_dir: string
  model_dir: string
  signal: AbortSignal
  tsci_bin: string
  append: (stream: JobLogStream, message: string) => Promise<void>
}): Promise<void> {
  const temporary_component = join(input.model_dir, "component-with-model.circuit.tsx")
  const output_root = join(input.model_dir, ".benchmark-source-check")
  if (await Bun.file(temporary_component).exists()) {
    throw new Error("A model wrapper exists before provisional benchmark validation")
  }
  await writeServerStructuralComponent({ model_dir: input.model_dir })
  try {
    const benchmark_files = await listModelBenchFiles(input.model_dir)
    if (input.signal.aborted) throw new Error("Provisional benchmark validation was cancelled")
    await input.append(
      "system",
      `Source-checking ${benchmark_files.length} provisional benchmark circuit(s) before locking; ngspice is not run in this phase…\n`,
    )
    await rm(output_root, { recursive: true, force: true })
    const result = await Bun.build({
      entrypoints: benchmark_files.map((file) => join(input.model_dir, "benchmarks", file)),
      outdir: output_root,
      target: "bun",
      format: "esm",
      packages: "external",
      naming: "[dir]/[name].[ext]",
    })
    if (!result.success) {
      const details = result.logs
        .map((log) => log.message)
        .filter(Boolean)
        .join("; ")
      throw new Error(`Benchmark source compilation failed${details ? `: ${details}` : ""}`)
    }
    if (input.signal.aborted) throw new Error("Provisional benchmark validation was cancelled")

    const originals = await Promise.all(
      benchmark_files.map(async (benchmark_file) => {
        const source_path = join(input.model_dir, "benchmarks", benchmark_file)
        return {
          benchmark_file,
          source_path,
          source: await readFile(source_path, "utf8"),
        }
      }),
    )
    try {
      await Promise.all(
        originals.map(({ benchmark_file, source_path, source }) =>
          Bun.write(source_path, stripAnalogSimulationForStructuralCheck(source, benchmark_file)),
        ),
      )
      await input.append(
        "system",
        `Structurally rendering ${benchmark_files.length} provisional benchmark circuit(s) before locking; analog simulation remains disabled…\n`,
      )
      let next_index = 0
      const failures: string[] = []
      const worker = async () => {
        while (!input.signal.aborted) {
          const benchmark_file = benchmark_files[next_index]
          next_index += 1
          if (!benchmark_file) return
          const benchmark_id = benchmark_file.replace(/\.circuit\.tsx$/i, "")
          const generated_path = join(
            input.job_dir,
            "dist",
            "spice",
            "benchmarks",
            benchmark_id,
            "circuit.json",
          )
          await rm(dirname(generated_path), { recursive: true, force: true })
          let process_output = ""
          const exit_code = await streamModelProcess({
            command: [
              input.tsci_bin,
              "build",
              `benchmarks/${benchmark_file}`,
              "--ignore-warnings",
              "--disable-pcb",
              "--routing-disabled",
              "--disable-parts-engine",
            ],
            cwd: input.model_dir,
            signal: input.signal,
            on_chunk: async (stream, message) => {
              process_output = captureProcessOutput(process_output, message)
              await input.append(stream, message)
            },
          })
          if (exit_code !== 0) {
            const failure = summarizeProcessFailure(process_output)
            if (/jsxDEV\d*\s+is not a function/i.test(process_output)) {
              throw new ModelInfrastructureError(
                `Benchmark structural-render JSX runtime failed: ${benchmark_file}: ${failure}`,
              )
            }
            failures.push(`${benchmark_file}: ${failure}`)
            continue
          }
          try {
            const circuit_json: unknown = JSON.parse(await readFile(generated_path, "utf8"))
            const diagnostics = getCircuitBuildDiagnostics(circuit_json)
            const errors = [...diagnostics.source_errors, ...diagnostics.simulation_errors]
            if (errors.length > 0) failures.push(`${benchmark_file}: ${errors.join("; ")}`)
          } catch (error) {
            failures.push(`${benchmark_file}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(getValidationConcurrency(), benchmark_files.length) }, () => worker()),
      )
      if (input.signal.aborted) throw new Error("Provisional benchmark validation was cancelled")
      if (failures.length > 0) {
        throw new Error(`Benchmark structural render failed: ${failures.join(" | ")}`)
      }
    } finally {
      await Promise.all(originals.map(({ source_path, source }) => Bun.write(source_path, source)))
    }
  } finally {
    await Promise.all([
      rm(temporary_component, { force: true }),
      rm(output_root, { recursive: true, force: true }),
    ])
  }
}

function readRequiredLiteralJsxAttribute(input: {
  attributes: ts.JsxAttributes
  source_file: ts.SourceFile
  benchmark_file: string
  attribute_name: string
  required: boolean
}): string | undefined {
  const { attributes, source_file, benchmark_file, attribute_name, required } = input
  const matches = attributes.properties.filter(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText(source_file) === attribute_name,
  )
  if (attributes.properties.some(ts.isJsxSpreadAttribute)) {
    throw new Error(
      `Benchmark ${benchmark_file} analogsimulation must use explicit attributes, not JSX spreads`,
    )
  }
  if (matches.length === 0) {
    if (required) {
      throw new Error(`Benchmark ${benchmark_file} analogsimulation must set ${attribute_name}`)
    }
    return undefined
  }
  if (matches.length !== 1) {
    throw new Error(`Benchmark ${benchmark_file} analogsimulation duplicates ${attribute_name}`)
  }
  const initializer = matches[0]!.initializer
  if (initializer && ts.isStringLiteral(initializer)) return initializer.text
  if (
    initializer &&
    ts.isJsxExpression(initializer) &&
    initializer.expression &&
    (ts.isStringLiteral(initializer.expression) || ts.isNoSubstitutionTemplateLiteral(initializer.expression))
  ) {
    return initializer.expression.text
  }
  throw new Error(`Benchmark ${benchmark_file} analogsimulation ${attribute_name} must be a string literal`)
}

function assertAnalogSimulationContract(input: {
  attributes: ts.JsxAttributes
  source_file: ts.SourceFile
  benchmark_file: string
}): void {
  const { attributes, source_file, benchmark_file } = input
  const spice_engine = readRequiredLiteralJsxAttribute({
    attributes,
    source_file,
    benchmark_file,
    attribute_name: "spiceEngine",
    required: true,
  })
  if (spice_engine !== "ngspice") {
    throw new Error(`Benchmark ${benchmark_file} analogsimulation spiceEngine must be "ngspice"`)
  }
  const simulation_type = readRequiredLiteralJsxAttribute({
    attributes,
    source_file,
    benchmark_file,
    attribute_name: "simulationType",
    required: false,
  })
  if (simulation_type !== undefined && simulation_type !== "spice_transient_analysis") {
    throw new Error(
      `Benchmark ${benchmark_file} analogsimulation simulationType must be "spice_transient_analysis" or omitted`,
    )
  }
}

export function stripAnalogSimulationForStructuralCheck(source: string, benchmark_file: string): string {
  const source_file = ts.createSourceFile(
    benchmark_file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const spans: Array<{ start: number; end: number }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source_file) === "analogsimulation") {
      assertAnalogSimulationContract({ attributes: node.attributes, source_file, benchmark_file })
      spans.push({ start: node.getFullStart(), end: node.end })
      return
    }
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source_file) === "analogsimulation") {
      assertAnalogSimulationContract({
        attributes: node.openingElement.attributes,
        source_file,
        benchmark_file,
      })
      spans.push({ start: node.getFullStart(), end: node.end })
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source_file)
  if (spans.length !== 1) {
    throw new Error(
      `Benchmark ${benchmark_file} must contain exactly one removable analogsimulation for structural validation`,
    )
  }
  const [{ start, end }] = spans
  return `${source.slice(0, start)}${source.slice(end)}`
}
