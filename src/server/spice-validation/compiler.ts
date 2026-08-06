import type { ModelManifest } from "@/shared/job-types"
import { getDutNodeName, getFixtureElementName, getNetNodeName, parseEndpointSyntax } from "./identifiers"
import type {
  CompiledObservation,
  CompiledValidationCase,
  FixtureElement,
  SpiceEndpoint,
  ValidationAnalysis,
  ValidationCase,
} from "./types"

export class ValidationCompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ValidationCompileError"
  }
}

export function formatSpiceNumber(value: number): string {
  if (!Number.isFinite(value)) throw new ValidationCompileError("Cannot compile a non-finite number")
  return Object.is(value, -0) ? "0" : value.toString()
}

function compilePulse(
  pulse: NonNullable<Extract<FixtureElement, { type: "voltage_source" }>["pulse"]>,
): string {
  return `PULSE(${[pulse.low, pulse.high, pulse.delay, pulse.rise, pulse.fall, pulse.width, pulse.period]
    .map(formatSpiceNumber)
    .join(" ")})`
}

function getNodeResolver(
  manifest: ModelManifest,
  validation_case: ValidationCase,
): (endpoint: SpiceEndpoint) => string {
  const dut_nodes = new Map(manifest.pins.map((pin, index) => [pin.spice_node, getDutNodeName(index)]))
  const grouped_dut_nodes = new Map<string, string>()
  for (const group of validation_case.application_fixture?.node_groups ?? []) {
    const group_node = group.is_ground ? "0" : getNetNodeName(group.id)
    for (const endpoint of group.dut_endpoints) {
      if (!endpoint.startsWith("dut.")) {
        throw new ValidationCompileError(
          `Application node group ${JSON.stringify(group.id)} contains non-DUT endpoint ${JSON.stringify(endpoint)}`,
        )
      }
      const spice_node = endpoint.slice("dut.".length)
      if (!dut_nodes.has(spice_node)) {
        throw new ValidationCompileError(
          `Application node group ${JSON.stringify(group.id)} references unknown DUT pin ${JSON.stringify(spice_node)}`,
        )
      }
      if (grouped_dut_nodes.has(spice_node)) {
        throw new ValidationCompileError(
          `DUT pin ${JSON.stringify(spice_node)} belongs to more than one application node group`,
        )
      }
      grouped_dut_nodes.set(spice_node, group_node)
    }
  }
  for (const overlay of validation_case.application_fixture?.condition_overlays ?? []) {
    if (!overlay.endpoint.startsWith("dut.")) {
      throw new ValidationCompileError(
        `Application logic overlay contains non-DUT endpoint ${JSON.stringify(overlay.endpoint)}`,
      )
    }
    const spice_node = overlay.endpoint.slice("dut.".length)
    if (!dut_nodes.has(spice_node) || grouped_dut_nodes.has(spice_node)) {
      throw new ValidationCompileError(
        `Application logic overlay endpoint ${JSON.stringify(spice_node)} is not one detached DUT pin`,
      )
    }
    if (overlay.type === "pulsed_source") continue
    const reference_node =
      overlay.reference === "gnd"
        ? "0"
        : overlay.reference.startsWith("dut.")
          ? grouped_dut_nodes.get(overlay.reference.slice("dut.".length))
          : undefined
    if (!reference_node) {
      throw new ValidationCompileError(
        `Application logic overlay reference ${JSON.stringify(overlay.reference)} is not anchored by the resolved topology`,
      )
    }
    grouped_dut_nodes.set(spice_node, reference_node)
  }
  return (endpoint) => {
    const parsed = parseEndpointSyntax(endpoint)
    if (!parsed) throw new ValidationCompileError(`Invalid endpoint ${JSON.stringify(endpoint)}`)
    if (parsed.scope === "gnd") return "0"
    if (parsed.scope === "net") return getNetNodeName(parsed.identifier)
    const node = grouped_dut_nodes.get(parsed.identifier) ?? dut_nodes.get(parsed.identifier)
    if (!node) throw new ValidationCompileError(`Unknown DUT pin ${JSON.stringify(parsed.identifier)}`)
    return node
  }
}

function compileFixture(element: FixtureElement, resolve_node: (endpoint: SpiceEndpoint) => string): string {
  const name = getFixtureElementName(element)
  if (element.type === "diode") {
    return `${name} ${resolve_node(element.anode)} ${resolve_node(element.cathode)} D_VALIDATION`
  }
  const terminals = `${resolve_node(element.positive)} ${resolve_node(element.negative)}`
  switch (element.type) {
    case "resistor":
      return `${name} ${terminals} ${formatSpiceNumber(element.resistance_ohms)}`
    case "capacitor":
      return `${name} ${terminals} ${formatSpiceNumber(element.capacitance_farads)}`
    case "inductor":
      return `${name} ${terminals} ${formatSpiceNumber(element.inductance_henries)}`
    case "voltage_source":
      return `${name} ${terminals} DC ${formatSpiceNumber(element.dc_volts)}${
        element.pulse ? ` ${compilePulse(element.pulse)}` : ""
      }`
    case "current_source":
      return `${name} ${terminals} DC ${formatSpiceNumber(element.dc_amps)}${
        element.pulse ? ` ${compilePulse(element.pulse)}` : ""
      }`
  }
}

function getCurrentVector(element: FixtureElement, element_name: string): string {
  switch (element.type) {
    case "voltage_source":
    case "inductor":
      return `i(${element_name})`
    case "current_source":
    case "resistor":
    case "capacitor":
      return `@${element_name}[i]`
    case "diode":
      return `@${element_name}[id]`
  }
}

function compileObservation(input: {
  observation: ValidationCase["observations"][number]
  fixture_by_id: Map<string, FixtureElement>
  element_names: Record<string, string>
  resolve_node: (endpoint: SpiceEndpoint) => string
}): CompiledObservation {
  const { observation, resolve_node } = input
  if (observation.type === "voltage") {
    const positive_node = resolve_node(observation.positive)
    const negative_node = resolve_node(observation.negative)
    const saved_vectors = [
      ...new Set([positive_node, negative_node].filter((node) => node !== "0").map((node) => `v(${node})`)),
    ]
    return { observation, positive_node, negative_node, saved_vectors }
  }
  const element = input.fixture_by_id.get(observation.element_id)
  const element_name = input.element_names[observation.element_id]
  if (!element || !element_name) {
    throw new ValidationCompileError(
      `Observation ${JSON.stringify(observation.id)} references unknown element ${JSON.stringify(observation.element_id)}`,
    )
  }
  return {
    observation,
    element_name,
    saved_vectors: [getCurrentVector(element, element_name)],
  }
}

function compileAnalysis(
  analysis: ValidationAnalysis,
  fixture_by_id: Map<string, FixtureElement>,
  element_names: Record<string, string>,
): string {
  if (analysis.type === "operating_point") return ".op"
  if (analysis.type === "transient") {
    return `.tran ${formatSpiceNumber(analysis.step)} ${formatSpiceNumber(analysis.stop)}${
      analysis.start === undefined ? "" : ` ${formatSpiceNumber(analysis.start)}`
    }`
  }
  const source = fixture_by_id.get(analysis.source_id)
  const source_name = element_names[analysis.source_id]
  if (!source || !source_name || (source.type !== "voltage_source" && source.type !== "current_source")) {
    throw new ValidationCompileError(`DC sweep source ${JSON.stringify(analysis.source_id)} is invalid`)
  }
  return `.dc ${source_name} ${formatSpiceNumber(analysis.start)} ${formatSpiceNumber(
    analysis.stop,
  )} ${formatSpiceNumber(analysis.step)}`
}

export function compileValidationCase(
  validation_case: ValidationCase,
  manifest: ModelManifest,
): CompiledValidationCase {
  const resolve_node = getNodeResolver(manifest, validation_case)
  const fixtures = [...validation_case.fixtures].sort((a, b) => a.id.localeCompare(b.id))
  const fixture_by_id = new Map(fixtures.map((fixture) => [fixture.id, fixture]))
  const element_names = Object.fromEntries(
    fixtures.map((fixture) => [fixture.id, getFixtureElementName(fixture)]),
  )
  const observations = validation_case.observations.map((observation) =>
    compileObservation({ observation, fixture_by_id, element_names, resolve_node }),
  )
  const saved_vectors = [...new Set(observations.flatMap((observation) => observation.saved_vectors))].sort()
  if (saved_vectors.length === 0) {
    throw new ValidationCompileError(`Case ${JSON.stringify(validation_case.id)} has no save vectors`)
  }
  const dut_nodes = manifest.pins.map(({ spice_node }) => resolve_node(`dut.${spice_node}`))
  const lines = [
    `* spice-validation version 1 case ${validation_case.id}`,
    ".include ../model.lib",
    `X_DUT ${dut_nodes.join(" ")} ${manifest.entry_name}`,
    ...(fixtures.some((fixture) => fixture.type === "diode") ? [".model D_VALIDATION D"] : []),
    ...fixtures.map((fixture) => compileFixture(fixture, resolve_node)),
    `.save ${saved_vectors.join(" ")}`,
    compileAnalysis(validation_case.analysis, fixture_by_id, element_names),
    ".end",
    "",
  ]
  const source = lines.join("\n")
  if (/^\s*\.measure\b/im.test(source)) {
    throw new ValidationCompileError("Compiler invariant failed: .measure is forbidden")
  }
  return { case_id: validation_case.id, source, observations, element_names }
}
