import ts from "typescript"
import { parseBenchmarkManifest } from "../model-scorer"
import { BenchmarkRecord } from "./types"
import { isRecord } from "./benchmark-lock-paths"

export function parseBenchmarkRecords(value: unknown): BenchmarkRecord[] {
  return parseBenchmarkManifest(value).benchmarks.map((entry) => ({
    id: entry.id,
    source_image: entry.source.image,
    series: entry.series.map((series) => ({
      id: series.id,
      role: series.role,
      quantity: series.quantity,
      unit: series.unit,
      reference_file: series.reference_file,
      source_image: series.source_image,
      simulation: series.simulation,
    })),
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
): { found: boolean; target?: string; reference?: string } {
  let result: { found: boolean; target?: string; reference?: string } = { found: false }
  const visit = (node: ts.Node): void => {
    if (result.found) return
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText() === "voltageprobe" &&
      readLiteralJsxAttribute(node, "name") === probe_name
    ) {
      result = {
        found: true,
        target: readLiteralJsxAttribute(node, "connectsTo"),
        reference: readLiteralJsxAttribute(node, "referenceTo"),
      }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source_file)
  return result
}

function countNamedResistors(source_file: ts.SourceFile, resistor_name: string): number {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText() === "resistor" &&
      readLiteralJsxAttribute(node, "name") === resistor_name
    ) {
      count += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(source_file)
  return count
}

function isDirectComponentPin(target: string, component_name: string): boolean {
  const escaped_name = component_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    `^(?:${escaped_name}\\.(?:pin)?[12]|\\.${escaped_name}\\s*>\\s*\\.(?:pin)?[12])$`,
    "i",
  ).test(target)
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
  for (const series of benchmark.series) {
    if (
      !isRecord(series.simulation) ||
      typeof series.simulation.probe_name !== "string" ||
      !series.simulation.probe_name.trim() ||
      (series.role === "response" &&
        (typeof series.simulation.dut_spice_node !== "string" || !series.simulation.dut_spice_node.trim()))
    ) {
      throw new Error(
        `Benchmark ${benchmark.id} series ${series.id} must declare simulation.probe_name${
          series.role === "response" ? " and simulation.dut_spice_node" : ""
        }`,
      )
    }
    const probe_name = series.simulation.probe_name
    const quantity = series.quantity.trim().toLowerCase()
    const sense_resistor =
      typeof series.simulation.sense_resistor === "string"
        ? series.simulation.sense_resistor.trim()
        : undefined
    if (quantity === "current") {
      if (!sense_resistor) {
        throw new Error(
          `Benchmark ${benchmark.id} current series ${series.id} must declare simulation.sense_resistor`,
        )
      }
      if (countNamedResistors(source_file, sense_resistor) !== 1) {
        throw new Error(
          `Benchmark ${benchmark.id} current series ${series.id} must define exactly one resistor named ${sense_resistor}`,
        )
      }
      if (
        typeof series.simulation.scale !== "number" ||
        !Number.isFinite(series.simulation.scale) ||
        series.simulation.scale === 0
      ) {
        throw new Error(
          `Benchmark ${benchmark.id} current series ${series.id} must declare a non-zero simulation.scale`,
        )
      }
    }
    const probe = findVoltageProbe(source_file, probe_name)
    if (!probe.found) {
      throw new Error(`Benchmark ${benchmark.id} series ${series.id} must define voltage probe ${probe_name}`)
    }
    const probe_target = probe.target
    if (!probe_target) {
      throw new Error(`Benchmark ${benchmark.id} voltage probe ${probe_name} must declare connectsTo`)
    }
    if (quantity === "current") {
      if (
        !probe.reference ||
        !sense_resistor ||
        !isDirectComponentPin(probe_target, sense_resistor) ||
        !isDirectComponentPin(probe.reference, sense_resistor) ||
        probe_target.toLowerCase() === probe.reference.toLowerCase()
      ) {
        throw new Error(
          `Benchmark ${benchmark.id} current probe ${probe_name} must measure differentially across both pins of sense resistor ${sense_resistor}`,
        )
      }
    } else if (
      series.role === "response" &&
      !/^(?:DUT\.[A-Za-z_$][\w$-]*|\.DUT\s*>\s*\.[A-Za-z_$][\w$-]*)$/.test(probe_target)
    ) {
      throw new Error(
        `Benchmark ${benchmark.id} response probe ${probe_name} must connect directly to a DUT port, for example .DUT > .VOUT`,
      )
    }
    if (
      series.role === "stimulus" &&
      series.quantity.trim().toLowerCase() === "voltage" &&
      !/^(?:DUT\.[A-Za-z_$][\w$-]*|\.DUT\s*>\s*\.[A-Za-z_$][\w$-]*)$/.test(probe_target)
    ) {
      throw new Error(
        `Benchmark ${benchmark.id} voltage-stimulus probe ${probe_name} must measure the applied waveform directly at its DUT port, for example .DUT > .VIN`,
      )
    }
  }
  if (/\b(selector|telemetry|benchmark[_ -]?code|metric[_ -]?channel)\b/i.test(source)) {
    throw new Error(`Benchmark ${benchmark.id} contains a synthetic benchmark backchannel`)
  }
}
