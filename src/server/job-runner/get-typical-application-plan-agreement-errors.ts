import { normalizeElectricalPinLabel } from "../pin-label-normalization"
import {
  canonicalizeTypicalApplicationPlan,
  type TypicalApplicationPlan,
} from "./parse-typical-application-plan"

function normalizedText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

export function normalizedIdentifier(value: string | undefined): string {
  return normalizedText(value).replace(/[^a-z0-9]+/g, "")
}

function componentKind(kind: string, reference: string): string {
  const normalized = normalizedIdentifier(kind)
  const explicit_kinds: Array<[string, RegExp]> = [
    ["resistor", /resistor|thermistor|potentiometer/],
    ["capacitor", /capacitor/],
    ["inductor", /inductor|ferritebead/],
    ["diode", /diode|led/],
    ["transistor", /transistor|mosfet|bjt/],
    ["connector", /connector|header|socket/],
    ["crystal", /crystal|resonator|oscillator/],
    ["switch", /switch|pushbutton|button/],
    ["fuse", /fuse/],
    ["transformer", /transformer/],
    ["integrated_circuit", /^(?:ic|integratedcircuit|chip)$/],
  ]
  const explicit = explicit_kinds.find(([, pattern]) => pattern.test(normalized))?.[0]
  if (explicit) return explicit

  const designator = reference
    .trim()
    .match(/^[a-z]+/i)?.[0]
    ?.toUpperCase()
  return (
    {
      R: "resistor",
      C: "capacitor",
      L: "inductor",
      D: "diode",
      LED: "diode",
      Q: "transistor",
      J: "connector",
      P: "connector",
      Y: "crystal",
      X: "crystal",
      SW: "switch",
      F: "fuse",
      T: "transformer",
      U: "integrated_circuit",
    }[designator ?? ""] ?? normalized
  )
}

const ENGINEERING_PREFIXES: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  "": 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
}

function engineeringValue(value: string | undefined): number | undefined {
  if (!value) return undefined
  const normalized = value
    .trim()
    .replace(/[\u00b5\u03bc]/g, "u")
    .replace(/^\d+\s*[x×]\s*/i, "")
  const match = normalized.match(
    /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([pnumkKMG]?)(?:\s*(?:ohms?|\u03a9|[FfHh]))?(?=$|[\s,;])/i,
  )
  if (!match) return undefined
  const amount = Number(match[1])
  const multiplier = ENGINEERING_PREFIXES[match[2] ?? ""]
  return Number.isFinite(amount) && multiplier !== undefined ? amount * multiplier : undefined
}

function componentValuesAgree(input: {
  primary_value?: string
  independent_value?: string
  kind: string
  target_part_number?: string
}): boolean {
  const { primary_value, independent_value, kind, target_part_number } = input
  if (primary_value === undefined && independent_value === undefined) return true
  const target_identifier = normalizedIdentifier(target_part_number)
  if (
    kind === "integrated_circuit" &&
    target_identifier.length >= 4 &&
    [primary_value, independent_value].every(
      (value) => value === undefined || normalizedIdentifier(value).startsWith(target_identifier),
    )
  ) {
    // Component evidence owns U1 identity. Application agents may repeat either the base or
    // orderable part number, or omit the redundant value, without creating an electrical split.
    return true
  }
  if (primary_value === undefined || independent_value === undefined) return false
  const primary_engineering_value = engineeringValue(primary_value)
  const independent_engineering_value = engineeringValue(independent_value)
  if (primary_engineering_value !== undefined && independent_engineering_value !== undefined) {
    const scale = Math.max(
      Math.abs(primary_engineering_value),
      Math.abs(independent_engineering_value),
      1e-18,
    )
    return Math.abs(primary_engineering_value - independent_engineering_value) / scale <= 1e-9
  }
  const primary_identifier = normalizedIdentifier(primary_value)
  const independent_identifier = normalizedIdentifier(independent_value)
  if (primary_identifier === independent_identifier) return true
  return (
    kind === "integrated_circuit" &&
    target_identifier.length >= 4 &&
    primary_identifier.startsWith(target_identifier) &&
    independent_identifier.startsWith(target_identifier)
  )
}

type ApplicationComponent = TypicalApplicationPlan["components"][number]

function symmetricTwoTerminalReferences(plan: TypicalApplicationPlan): Set<string> {
  return new Set(
    plan.components.flatMap((component) =>
      ["resistor", "inductor", "fuse"].includes(componentKind(component.kind, component.reference))
        ? [normalizedIdentifier(component.reference)]
        : [],
    ),
  )
}

function normalizedEndpoint(
  endpoint: string,
  input: {
    reference_map?: Map<string, string>
    symmetric_references: Set<string>
  },
): string {
  const separator = endpoint.indexOf(".")
  const original_component = normalizedIdentifier(endpoint.slice(0, separator))
  const component = input.reference_map?.get(original_component) ?? original_component
  let port = normalizeElectricalPinLabel(endpoint.slice(separator + 1)).replace(/^pin(?=\d+$)/, "")
  if (input.symmetric_references.has(original_component) && (port === "1" || port === "2")) {
    port = "terminal"
  }
  return `${component}.${port}`
}

function getConnectionGroups(plan: TypicalApplicationPlan, reference_map?: Map<string, string>) {
  const symmetric_references = symmetricTwoTerminalReferences(plan)
  return new Map(
    plan.connections.map((connection) => {
      const pins = connection.pins
        .map((endpoint) => normalizedEndpoint(endpoint, { reference_map, symmetric_references }))
        .sort()
      return [JSON.stringify(pins), { net: connection.net, pins }] as const
    }),
  )
}

function getConnectionGroupKeys(plan: TypicalApplicationPlan, reference_map?: Map<string, string>): string[] {
  const symmetric_references = symmetricTwoTerminalReferences(plan)
  return plan.connections
    .map((connection) =>
      JSON.stringify(
        connection.pins
          .map((endpoint) => normalizedEndpoint(endpoint, { reference_map, symmetric_references }))
          .sort(),
      ),
    )
    .sort()
}

function getConnectionAgreementErrors(input: {
  primary: TypicalApplicationPlan
  independent: TypicalApplicationPlan
  independent_reference_map?: Map<string, string>
}): string[] {
  const errors: string[] = []
  const independent_connections = getConnectionGroups(input.independent, input.independent_reference_map)
  for (const connection of getConnectionGroups(input.primary).values()) {
    const key = JSON.stringify(connection.pins)
    if (!independent_connections.delete(key)) {
      errors.push(
        `independent typical application is missing the endpoint group from net ${JSON.stringify(connection.net)}: ${connection.pins.join(", ")}`,
      )
    }
  }
  for (const connection of independent_connections.values()) {
    errors.push(
      `independent typical application has an unexpected endpoint group on net ${JSON.stringify(connection.net)}: ${connection.pins.join(", ")}`,
    )
  }
  return errors
}

function connectionGroupDifferenceCount(left: string[], right: string[]): number {
  const right_counts = new Map<string, number>()
  for (const key of right) right_counts.set(key, (right_counts.get(key) ?? 0) + 1)
  let differences = 0
  for (const key of left) {
    const remaining = right_counts.get(key) ?? 0
    if (remaining === 0) differences += 1
    else right_counts.set(key, remaining - 1)
  }
  return differences + [...right_counts.values()].reduce((sum, count) => sum + count, 0)
}

function componentsAgreeForReferenceMapping(input: {
  primary: ApplicationComponent
  independent: ApplicationComponent
  pcb_implementation?: TypicalApplicationPlan["pcb_implementation"]
  target_part_number?: string
}): boolean {
  const { primary, independent, pcb_implementation, target_part_number } = input
  const primary_kind = componentKind(primary.kind, primary.reference)
  const independent_kind = componentKind(independent.kind, independent.reference)
  if (primary_kind !== independent_kind) return false
  if (
    !componentValuesAgree({
      primary_value: primary.value,
      independent_value: independent.value,
      kind: primary_kind,
      target_part_number,
    })
  ) {
    return false
  }
  if (pcb_implementation !== "verified" || normalizedIdentifier(primary.reference) === "u1") {
    return true
  }
  return (
    normalizedIdentifier(primary.manufacturer_part_number) ===
      normalizedIdentifier(independent.manufacturer_part_number) &&
    (primary.footprint ?? "").trim() === (independent.footprint ?? "").trim()
  )
}

function componentConnectionSignature(plan: TypicalApplicationPlan, reference: string): string {
  const normalized_reference = normalizedIdentifier(reference)
  const connection_arities: number[] = []
  const target_ports: string[] = []
  for (const connection of plan.connections) {
    const includes_component = connection.pins.some((endpoint) => {
      const separator = endpoint.indexOf(".")
      return normalizedIdentifier(endpoint.slice(0, separator)) === normalized_reference
    })
    if (!includes_component) continue
    connection_arities.push(connection.pins.length)
    for (const endpoint of connection.pins) {
      const separator = endpoint.indexOf(".")
      if (normalizedIdentifier(endpoint.slice(0, separator)) !== "u1") continue
      target_ports.push(
        normalizeElectricalPinLabel(endpoint.slice(separator + 1)).replace(/^pin(?=\d+$)/, ""),
      )
    }
  }
  return JSON.stringify({
    connection_arities: connection_arities.sort((left, right) => left - right),
    target_ports: target_ports.sort(),
  })
}

function findSemanticReferenceMap(input: {
  primary: TypicalApplicationPlan
  independent: TypicalApplicationPlan
  target_part_number?: string
}): Map<string, string> | undefined {
  const { primary, independent, target_part_number } = input
  if (primary.components.length !== independent.components.length) return undefined

  const primary_target = primary.components.find(
    (component) => normalizedIdentifier(component.reference) === "u1",
  )
  const independent_target = independent.components.find(
    (component) => normalizedIdentifier(component.reference) === "u1",
  )
  if (
    !primary_target ||
    !independent_target ||
    !componentsAgreeForReferenceMapping({
      primary: primary_target,
      independent: independent_target,
      pcb_implementation: primary.pcb_implementation,
      target_part_number,
    })
  ) {
    return undefined
  }

  const primary_components = primary.components.filter(
    (component) => normalizedIdentifier(component.reference) !== "u1",
  )
  const independent_components = independent.components.filter(
    (component) => normalizedIdentifier(component.reference) !== "u1",
  )
  const candidates = primary_components.map((primary_component) => ({
    primary: primary_component,
    independent: independent_components
      .filter((independent_component) =>
        componentsAgreeForReferenceMapping({
          primary: primary_component,
          independent: independent_component,
          pcb_implementation: primary.pcb_implementation,
          target_part_number,
        }),
      )
      .sort((left, right) => {
        const primary_reference = normalizedIdentifier(primary_component.reference)
        const left_exact = normalizedIdentifier(left.reference) === primary_reference ? 0 : 1
        const right_exact = normalizedIdentifier(right.reference) === primary_reference ? 0 : 1
        if (left_exact !== right_exact) return left_exact - right_exact
        const primary_signature = componentConnectionSignature(primary, primary_component.reference)
        const left_signature = componentConnectionSignature(independent, left.reference)
        const right_signature = componentConnectionSignature(independent, right.reference)
        return Number(left_signature !== primary_signature) - Number(right_signature !== primary_signature)
      }),
  }))
  if (candidates.some((candidate) => candidate.independent.length === 0)) return undefined
  candidates.sort((left, right) => left.independent.length - right.independent.length)

  const primary_connection_keys = getConnectionGroupKeys(primary)
  const reference_map = new Map<string, string>([["u1", "u1"]])
  const used_independent_references = new Set<string>(["u1"])
  let searches = 0
  let best: { differences: number; reference_map: Map<string, string> } | undefined
  const search = (index: number): void => {
    searches += 1
    if (searches > 50_000) return
    if (index >= candidates.length) {
      const independent_connection_keys = getConnectionGroupKeys(independent, reference_map)
      const differences = connectionGroupDifferenceCount(primary_connection_keys, independent_connection_keys)
      if (!best || differences < best.differences) {
        best = { differences, reference_map: new Map(reference_map) }
      }
      return
    }
    const candidate = candidates[index]
    if (!candidate) return
    const primary_reference = normalizedIdentifier(candidate.primary.reference)
    for (const independent_component of candidate.independent) {
      const independent_reference = normalizedIdentifier(independent_component.reference)
      if (used_independent_references.has(independent_reference)) continue
      reference_map.set(independent_reference, primary_reference)
      used_independent_references.add(independent_reference)
      search(index + 1)
      used_independent_references.delete(independent_reference)
      reference_map.delete(independent_reference)
    }
  }
  search(0)
  return best?.reference_map
}

export function getTypicalApplicationPlanAgreementErrors(input: {
  primary: TypicalApplicationPlan
  independent: TypicalApplicationPlan
  target_part_number?: string
}): string[] {
  let { primary, independent } = input
  const { target_part_number } = input
  const errors: string[] = []
  primary = canonicalizeTypicalApplicationPlan(primary, target_part_number)
  independent = canonicalizeTypicalApplicationPlan(independent, target_part_number)
  if (primary.availability !== independent.availability) {
    errors.push(
      `typical-application availability disagrees: ${primary.availability} versus ${independent.availability}`,
    )
    return errors
  }
  if (primary.availability === "not_present") return errors
  if (primary.pcb_implementation !== independent.pcb_implementation) {
    errors.push(
      `typical-application PCB implementation disagrees: ${primary.pcb_implementation ?? "missing"} versus ${independent.pcb_implementation ?? "missing"}`,
    )
  }
  const semantic_reference_map = findSemanticReferenceMap({
    primary,
    independent,
    target_part_number,
  })
  if (semantic_reference_map) {
    errors.push(
      ...getConnectionAgreementErrors({
        primary,
        independent,
        independent_reference_map: semantic_reference_map,
      }),
    )
    return errors
  }

  const independent_components = new Map(
    independent.components.map(
      (component) => [normalizedIdentifier(component.reference), component] as const,
    ),
  )
  for (const primary_component of primary.components) {
    const reference = normalizedIdentifier(primary_component.reference)
    const independent_component = independent_components.get(reference)
    if (!independent_component) {
      errors.push(`independent typical application is missing component ${primary_component.reference}`)
      continue
    }
    independent_components.delete(reference)
    const primary_kind = componentKind(primary_component.kind, primary_component.reference)
    const independent_kind = componentKind(independent_component.kind, independent_component.reference)
    if (primary_kind !== independent_kind) {
      errors.push(
        `typical-application component ${primary_component.reference} kind disagrees: ${JSON.stringify(primary_component.kind)} versus ${JSON.stringify(independent_component.kind)}`,
      )
      continue
    }
    if (
      !componentValuesAgree({
        primary_value: primary_component.value,
        independent_value: independent_component.value,
        kind: primary_kind,
        target_part_number,
      })
    ) {
      errors.push(
        `typical-application component ${primary_component.reference} value disagrees: ${JSON.stringify(primary_component.value ?? "missing")} versus ${JSON.stringify(independent_component.value ?? "missing")}`,
      )
    }
    // U1 identity and geometry are approved independently by component evidence,
    // while a schematic-only application never claims external-part footprints.
    // Only a verified application PCB needs exact agreement on external MPNs and
    // footprints; comparing these optional fields in schematic-only plans makes
    // harmless extraction-detail differences terminal.
    const requires_exact_application_part = primary.pcb_implementation === "verified" && reference !== "u1"
    if (requires_exact_application_part) {
      if (
        normalizedIdentifier(primary_component.manufacturer_part_number) !==
        normalizedIdentifier(independent_component.manufacturer_part_number)
      ) {
        errors.push(
          `typical-application component ${primary_component.reference} manufacturer part number disagrees: ${JSON.stringify(primary_component.manufacturer_part_number ?? "missing")} versus ${JSON.stringify(independent_component.manufacturer_part_number ?? "missing")}`,
        )
      }
      if ((primary_component.footprint ?? "").trim() !== (independent_component.footprint ?? "").trim()) {
        errors.push(
          `typical-application component ${primary_component.reference} footprint disagrees: ${JSON.stringify(primary_component.footprint ?? "missing")} versus ${JSON.stringify(independent_component.footprint ?? "missing")}`,
        )
      }
    }
  }
  for (const independent_component of independent_components.values()) {
    errors.push(`independent typical application has unexpected component ${independent_component.reference}`)
  }

  errors.push(...getConnectionAgreementErrors({ primary, independent }))
  return errors
}
