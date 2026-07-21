import ts from "typescript"
import { parseBenchmarkManifest } from "../model-scorer"
import { BenchmarkRecord } from "./types"
import { isRecord } from "./benchmark-lock-paths"

export function parseBenchmarkRecords(value: unknown): BenchmarkRecord[] {
  return parseBenchmarkManifest(value).benchmarks.map((entry) => ({
    id: entry.id,
    reference_file: entry.reference_file,
    source_image: entry.source.image,
    simulation: entry.simulation,
  }))
}

function parseBenchmarkSource(source: string, benchmark_id: string): ts.SourceFile {
  const source_file = ts.createSourceFile(
    `${benchmark_id}.circuit.tsx`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  ) as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  const diagnostic = source_file.parseDiagnostics?.[0]
  if (diagnostic) {
    throw new Error(
      `Benchmark ${benchmark_id} has invalid TSX: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    )
  }
  return source_file
}

function readLiteralJsxAttribute(
  element: ts.JsxOpeningLikeElement,
  attribute_name: string,
): string | undefined {
  const attribute = element.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === attribute_name,
  )
  return attribute?.initializer && ts.isStringLiteral(attribute.initializer)
    ? attribute.initializer.text.trim()
    : undefined
}

function findVoltageProbe(
  source_file: ts.SourceFile,
  probe_name: string,
): { found: boolean; target?: string } {
  let result: { found: boolean; target?: string } = { found: false }
  const visit = (node: ts.Node): void => {
    if (result.found) return
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText() === "voltageprobe" &&
      readLiteralJsxAttribute(node, "name") === probe_name
    ) {
      result = { found: true, target: readLiteralJsxAttribute(node, "connectsTo") }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source_file)
  return result
}

function assertAnalogSimulationProps(source_file: ts.SourceFile, benchmark_id: string): void {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText() === "analogsimulation"
    ) {
      count += 1
      const attribute = node.attributes.properties.find(
        (property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) && property.name.getText() === "simulationType",
      )
      if (attribute) {
        const value =
          attribute.initializer && ts.isStringLiteral(attribute.initializer)
            ? attribute.initializer.text.trim()
            : undefined
        if (value !== "spice_transient_analysis") {
          throw new Error(
            `Benchmark ${benchmark_id} analogsimulation simulationType must be omitted or exactly "spice_transient_analysis"`,
          )
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source_file)
  if (count !== 1) {
    throw new Error(`Benchmark ${benchmark_id} must define exactly one analogsimulation`)
  }
}

export function assertBenchmarkSourceContract(source: string, benchmark: BenchmarkRecord): void {
  const source_file = parseBenchmarkSource(source, benchmark.id)
  if (
    !isRecord(benchmark.simulation) ||
    typeof benchmark.simulation.probe_name !== "string" ||
    !benchmark.simulation.probe_name.trim() ||
    typeof benchmark.simulation.dut_spice_node !== "string" ||
    !benchmark.simulation.dut_spice_node.trim()
  ) {
    throw new Error(
      `Benchmark ${benchmark.id} must declare simulation.probe_name and simulation.dut_spice_node`,
    )
  }
  if (!/component-with-model(?:\.circuit)?["']/.test(source)) {
    throw new Error(`Benchmark ${benchmark.id} must import component-with-model.circuit`)
  }
  if (!/<[A-Z][A-Za-z0-9_$]*\b[^>]*\bname=["']DUT["']/.test(source)) {
    throw new Error(`Benchmark ${benchmark.id} must instantiate exactly one model component named DUT`)
  }
  if ((source.match(/\bname=["']DUT["']/g) ?? []).length !== 1) {
    throw new Error(`Benchmark ${benchmark.id} must instantiate exactly one component named DUT`)
  }
  if (!/<analogsimulation\b[^>]*\bspiceEngine=["']ngspice["']/.test(source)) {
    throw new Error(`Benchmark ${benchmark.id} must run an ngspice analogsimulation`)
  }
  assertAnalogSimulationProps(source_file, benchmark.id)
  const probe_name = isRecord(benchmark.simulation) ? benchmark.simulation.probe_name : undefined
  if (typeof probe_name === "string") {
    const probe = findVoltageProbe(source_file, probe_name)
    if (!probe.found) {
      throw new Error(`Benchmark ${benchmark.id} must define voltage probe ${probe_name}`)
    }
    const probe_target = probe.target
    if (!probe_target || !/^(?:DUT\.[A-Za-z_$][\w$-]*|\.DUT\s*>\s*\.[A-Za-z_$][\w$-]*)$/.test(probe_target)) {
      throw new Error(
        `Benchmark ${benchmark.id} voltage probe ${probe_name} must connect directly to a DUT port, for example .DUT > .VOUT; net-only targets cannot be resolved by tscircuit simulation`,
      )
    }
  }
  if (/\b(selector|telemetry|benchmark[_ -]?code|metric[_ -]?channel)\b/i.test(source)) {
    throw new Error(`Benchmark ${benchmark.id} contains a synthetic benchmark backchannel`)
  }
}
