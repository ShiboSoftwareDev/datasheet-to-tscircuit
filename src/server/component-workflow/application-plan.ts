import { EVIDENCE_CONFIDENCES, EVIDENCE_METHODS } from "../component-evidence/contract"
import type { ExpectedApplicationConnection } from "../job-artifact-validator"
import { applicationSourceNetName, canonicalizeApplicationEndpoint } from "./application-endpoint"

export const TYPICAL_APPLICATION_PLAN_VERSION = 4 as const
export const TYPICAL_APPLICATION_AVAILABILITIES = ["documented", "not_present"] as const
export const PCB_IMPLEMENTATION_MODES = ["verified", "schematic_only"] as const

export interface ApplicationSourceReference {
  page: number
  figure?: string
  method?: (typeof EVIDENCE_METHODS)[number]
  confidence?: (typeof EVIDENCE_CONFIDENCES)[number]
  image?: string
  render_dpi?: number
  note?: string
}

function normalizedIdentifier(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
}

function componentReferenceKey(value: string): string {
  return value.trim().toLowerCase()
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowed_keys = new Set(allowed)
  const unexpected = Object.keys(value)
    .filter((key) => !allowed_keys.has(key))
    .sort()
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unexpected.join(", ")}`)
  }
}

export interface TypicalApplicationPlan {
  version: 4
  availability: (typeof TYPICAL_APPLICATION_AVAILABILITIES)[number]
  pcb_implementation?: (typeof PCB_IMPLEMENTATION_MODES)[number]
  title: string
  description: string
  source_references: ApplicationSourceReference[]
  searched_sections?: string[]
  components: Array<{
    reference: string
    kind: string
    value?: string
    purpose?: string
    manufacturer_part_number?: string
    footprint?: string
    source_references?: ApplicationSourceReference[]
    footprint_source_references?: ApplicationSourceReference[]
  }>
  connections: ExpectedApplicationConnection[]
}

export interface ApplicationTargetIdentity {
  part_number: string
  ordering_code?: string
}

type ApplicationTargetIdentityInput = string | ApplicationTargetIdentity

interface NormalizedApplicationTargetIdentity {
  part_number: string
  normalized_part_number: string
  selected_part_number: string
  normalized_selected_part_number: string
  has_distinct_ordering_code: boolean
}

export function applicationTargetIdentityFromEvidence(evidence: {
  part_number: { value: string }
  ordering_code?: { value: string }
}): ApplicationTargetIdentity {
  return {
    part_number: evidence.part_number.value,
    ...(evidence.ordering_code ? { ordering_code: evidence.ordering_code.value } : {}),
  }
}

function isInterfaceOnlyComponent(component: TypicalApplicationPlan["components"][number]): boolean {
  const kind = component.kind
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
  return /^(?:external|power|input|output|supply|net).*(?:port|terminal)$/.test(kind)
}

function normalizeTargetIdentity(
  target: ApplicationTargetIdentityInput | undefined,
): NormalizedApplicationTargetIdentity | undefined {
  if (target === undefined) return undefined
  const part_number = (typeof target === "string" ? target : target.part_number).trim()
  const ordering_code = (typeof target === "string" ? undefined : target.ordering_code)?.trim()
  const normalized_part_number = normalizedIdentifier(part_number)
  const normalized_ordering_code = normalizedIdentifier(ordering_code)
  if (!normalized_part_number) return undefined
  if (
    normalized_ordering_code &&
    normalized_ordering_code !== normalized_part_number &&
    !normalized_ordering_code.startsWith(normalized_part_number)
  ) {
    throw new Error(
      `ordering identity ${JSON.stringify(ordering_code)} must extend base part number ${JSON.stringify(part_number)}`,
    )
  }
  return {
    part_number,
    normalized_part_number,
    selected_part_number: ordering_code || part_number,
    normalized_selected_part_number: normalized_ordering_code || normalized_part_number,
    has_distinct_ordering_code:
      Boolean(normalized_ordering_code) && normalized_ordering_code !== normalized_part_number,
  }
}

function isTargetApplicationComponent(
  component: TypicalApplicationPlan["components"][number],
  target: NormalizedApplicationTargetIdentity | undefined,
): boolean {
  if (!target) return false
  const manufacturer_part_number = normalizedIdentifier(component.manufacturer_part_number)
  const reference = normalizedIdentifier(component.reference)
  const value = normalizedIdentifier(component.value)

  // Family and orderable identities are separate evidence fields. Never infer
  // their boundary from a shared string prefix or a package-code suffix.
  if (target.has_distinct_ordering_code) {
    if (
      manufacturer_part_number &&
      manufacturer_part_number !== target.normalized_part_number &&
      manufacturer_part_number !== target.normalized_selected_part_number
    ) {
      return false
    }
    if (
      value &&
      value !== target.normalized_part_number &&
      value !== target.normalized_selected_part_number
    ) {
      return false
    }
    if (value) return true
    if (manufacturer_part_number) return true
    return reference === target.normalized_part_number || reference === target.normalized_selected_part_number
  }

  if (
    manufacturer_part_number &&
    manufacturer_part_number !== target.normalized_selected_part_number &&
    manufacturer_part_number !== target.normalized_part_number
  ) {
    return false
  }
  if (manufacturer_part_number === target.normalized_selected_part_number) return true
  if (manufacturer_part_number) {
    return !value || value === manufacturer_part_number
  }
  return reference === target.normalized_part_number || value === target.normalized_part_number
}

function canonicalizeTypicalApplicationPlan(
  plan: TypicalApplicationPlan,
  target_identity?: ApplicationTargetIdentityInput,
): TypicalApplicationPlan {
  const target = normalizeTargetIdentity(target_identity)
  const matched_targets = plan.components.filter((component) =>
    isTargetApplicationComponent(component, target),
  )
  if (matched_targets.length > 1) {
    throw new Error(
      `documented typical application resolves ${matched_targets.length} components to target U1`,
    )
  }
  const explicit_u1 = plan.components.filter(
    (component) => normalizedIdentifier(component.reference) === "u1",
  )
  const target_component = target ? matched_targets[0] : explicit_u1[0]
  const target_reference = target_component ? normalizedIdentifier(target_component.reference) : undefined

  const interface_references = new Map<string, string>()
  for (const component of plan.components.filter(isInterfaceOnlyComponent)) {
    const terminal_identity = component.value?.trim()
    if (!terminal_identity || !/^[^.\s]+$/.test(terminal_identity)) {
      throw new Error(
        `interface-only component ${component.reference} must declare a bare external terminal identity in value`,
      )
    }
    interface_references.set(componentReferenceKey(component.reference), terminal_identity)
  }
  const canonical_components = plan.components
    .filter((component) => !isInterfaceOnlyComponent(component))
    .map((component) => {
      if (normalizedIdentifier(component.reference) !== target_reference) return component
      return {
        ...component,
        reference: "U1",
        // Bind U1 to server-validated evidence. This makes downstream generation
        // use the selected orderable even when the application figure only shows
        // the unsuffixed family name.
        ...(target
          ? {
              ...(target.has_distinct_ordering_code
                ? { value: target.part_number }
                : component.value === undefined
                  ? {}
                  : { value: component.value }),
              manufacturer_part_number: target.selected_part_number,
            }
          : {}),
      }
    })
  const seen_components = new Set<string>()
  for (const component of canonical_components) {
    const key = componentReferenceKey(component.reference)
    if (seen_components.has(key)) {
      throw new Error(
        `typical application canonicalization produces duplicate component ${component.reference}`,
      )
    }
    seen_components.add(key)
  }
  if (plan.availability === "documented") {
    const target_count = canonical_components.filter(
      (component) => normalizedIdentifier(component.reference) === "u1",
    ).length
    if (target_count !== 1 || !target_component) {
      const identity_hint = target
        ? `; application value must identify family ${JSON.stringify(target.part_number)}` +
          ` and manufacturer_part_number, when present, must identify that family or selected ordering identity ${JSON.stringify(target.selected_part_number)}`
        : ""
      throw new Error(
        `documented typical application must resolve exactly one target component to U1${identity_hint}`,
      )
    }
  }

  const connections = plan.connections.map((connection) => ({
    ...connection,
    pins: connection.pins.map((endpoint) => {
      const separator = endpoint.indexOf(".")
      if (separator < 0) return endpoint
      const reference = endpoint.slice(0, separator)
      const interface_reference = interface_references.get(componentReferenceKey(reference))
      if (interface_reference) return interface_reference
      return normalizedIdentifier(reference) === target_reference
        ? `U1.${endpoint.slice(separator + 1)}`
        : endpoint
    }),
  }))

  const seen_endpoints = new Map<string, string>()
  const source_net_identities = new Map<string, string>()
  const registerSourceNetIdentity = (identity: string): void => {
    const source_net_name = applicationSourceNetName(identity).toLowerCase()
    const earlier_identity = source_net_identities.get(source_net_name)
    if (earlier_identity !== undefined && earlier_identity.toLowerCase() !== identity.toLowerCase()) {
      throw new Error(
        `application net identities ${earlier_identity} and ${identity} collide after tscircuit net-name encoding`,
      )
    }
    source_net_identities.set(source_net_name, identity)
  }
  for (const connection of connections) {
    registerSourceNetIdentity(connection.net)
    if (connection.pins.length < 2) {
      throw new Error(
        `typical application net ${connection.net} must retain at least two endpoints after canonicalization`,
      )
    }
    if (!connection.pins.some((endpoint) => endpoint.includes("."))) {
      throw new Error(
        `typical application net ${connection.net} must retain at least one component.port endpoint after canonicalization`,
      )
    }
    for (const endpoint of connection.pins) {
      const key = endpoint.trim().toLowerCase()
      const earlier_net = seen_endpoints.get(key)
      if (earlier_net !== undefined) {
        throw new Error(
          `typical application canonical endpoint ${endpoint} is listed on both ${earlier_net} and ${connection.net}`,
        )
      }
      seen_endpoints.set(key, connection.net)
      if (!endpoint.includes(".")) registerSourceNetIdentity(endpoint)
    }
  }
  return {
    ...plan,
    components: canonical_components,
    connections,
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`)
  }
  return value
}

export function parseApplicationSourceReferences(input: {
  value: unknown
  label: string
  allow_unmaterialized_pdf_visual?: boolean
}): ApplicationSourceReference[] {
  if (!Array.isArray(input.value) || input.value.length === 0) {
    throw new Error(`${input.label} must cite at least one datasheet page`)
  }
  return input.value.map((source, index) => {
    const source_label = `${input.label}[${index}]`
    if (!isRecord(source) || !Number.isInteger(source.page) || (source.page as number) < 1) {
      throw new Error(`${source_label}.page must be a positive integer`)
    }
    assertOnlyKeys(
      source,
      ["page", "figure", "method", "confidence", "image", "render_dpi", "note"],
      source_label,
    )
    if (
      source.method !== undefined &&
      !EVIDENCE_METHODS.includes(source.method as (typeof EVIDENCE_METHODS)[number])
    ) {
      throw new Error(`${source_label}.method is invalid`)
    }
    if (
      source.confidence !== undefined &&
      !EVIDENCE_CONFIDENCES.includes(source.confidence as (typeof EVIDENCE_CONFIDENCES)[number])
    ) {
      throw new Error(`${source_label}.confidence is invalid`)
    }
    const parsed: ApplicationSourceReference = {
      page: source.page as number,
      ...(source.figure === undefined
        ? {}
        : { figure: requiredText(source.figure, `${source_label}.figure`) }),
      ...(source.method === undefined
        ? {}
        : { method: source.method as ApplicationSourceReference["method"] }),
      ...(source.confidence === undefined
        ? {}
        : {
            confidence: source.confidence as ApplicationSourceReference["confidence"],
          }),
      ...(source.image === undefined ? {} : { image: requiredText(source.image, `${source_label}.image`) }),
      ...(source.render_dpi === undefined
        ? {}
        : {
            render_dpi: requiredFiniteNumber(source.render_dpi, `${source_label}.render_dpi`),
          }),
      ...(source.note === undefined ? {} : { note: requiredText(source.note, `${source_label}.note`) }),
    }
    if (parsed.method === "pdf_visual") {
      if (input.allow_unmaterialized_pdf_visual) {
        // The server renders and replaces every agent/reviewer source image.
      } else if (!parsed.image || parsed.render_dpi !== 200) {
        throw new Error(`${source_label} must record an image rendered at exactly 200 DPI`)
      }
    }
    if ((parsed.method === "calculated" || parsed.method === "package_standard") && !parsed.note) {
      throw new Error(`${source_label} must explain its ${parsed.method} source in note`)
    }
    if (
      parsed.image &&
      (parsed.image.startsWith("/") || parsed.image.split(/[\\/]/).some((segment) => segment === ".."))
    ) {
      throw new Error(`${source_label}.image must be a relative path inside the evidence workspace`)
    }
    return parsed
  })
}

function optionalSourcedText(input: {
  value: unknown
  label: string
  allow_unmaterialized_pdf_visual: boolean
}): { value?: string; sources?: ApplicationSourceReference[] } {
  if (input.value === undefined || input.value === null) return {}
  if (typeof input.value === "string") return { value: requiredText(input.value, input.label) }
  if (!isRecord(input.value)) {
    throw new Error(`${input.label} must be a string or a sourced value object`)
  }
  assertOnlyKeys(input.value, ["value", "sources"], input.label)
  return {
    value: requiredText(input.value.value, `${input.label}.value`),
    sources: parseApplicationSourceReferences({
      value: input.value.sources,
      label: `${input.label}.sources`,
      allow_unmaterialized_pdf_visual: input.allow_unmaterialized_pdf_visual,
    }),
  }
}

function mergeSourceReferences(
  ...groups: Array<ApplicationSourceReference[] | undefined>
): ApplicationSourceReference[] | undefined {
  const merged = groups.flatMap((group) => group ?? [])
  if (merged.length === 0) return undefined
  const unique = new Map(merged.map((source) => [JSON.stringify(source), source]))
  return [...unique.values()]
}

function hasExactPartNumberSource(...groups: Array<ApplicationSourceReference[] | undefined>): boolean {
  return groups.some((group) =>
    group?.some((source) => source.method !== "calculated" && source.method !== "package_standard"),
  )
}

function hasFootprintSource(...groups: Array<ApplicationSourceReference[] | undefined>): boolean {
  return groups.some((group) => group?.some((source) => source.method !== "calculated"))
}

function optionalTextArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((item, index) => requiredText(item, `${label}[${index}]`))
}

function parseTypicalApplicationPlanWithOptions(
  value: unknown,
  options: {
    target_identity?: ApplicationTargetIdentityInput
    allow_unmaterialized_pdf_visual: boolean
  },
): TypicalApplicationPlan {
  if (isRecord(value)) {
    assertOnlyKeys(
      value,
      [
        "version",
        "availability",
        "pcb_implementation",
        "title",
        "description",
        "source_references",
        "searched_sections",
        "components",
        "connections",
      ],
      "typical-application-plan.json",
    )
  }
  if (!isRecord(value) || value.version !== TYPICAL_APPLICATION_PLAN_VERSION) {
    throw new Error("typical-application-plan.json must have version 4")
  }
  const availability = value.availability
  if (
    !TYPICAL_APPLICATION_AVAILABILITIES.includes(
      availability as (typeof TYPICAL_APPLICATION_AVAILABILITIES)[number],
    )
  ) {
    throw new Error("typical-application-plan.json must declare documented or not_present")
  }
  const raw_pcb_implementation = value.pcb_implementation
  if (
    raw_pcb_implementation !== undefined &&
    !PCB_IMPLEMENTATION_MODES.includes(raw_pcb_implementation as (typeof PCB_IMPLEMENTATION_MODES)[number])
  ) {
    throw new Error("pcb_implementation must be verified or schematic_only")
  }
  if (
    availability === "documented" &&
    raw_pcb_implementation !== "verified" &&
    raw_pcb_implementation !== "schematic_only"
  ) {
    throw new Error(
      "documented typical-application evidence must declare pcb_implementation verified or schematic_only",
    )
  }
  if (availability === "not_present" && raw_pcb_implementation !== undefined) {
    throw new Error("not_present typical-application evidence must omit pcb_implementation")
  }
  const pcb_implementation = raw_pcb_implementation as
    | TypicalApplicationPlan["pcb_implementation"]
    | undefined
  const source_references = parseApplicationSourceReferences({
    value: value.source_references,
    label: "typical application source_references",
    allow_unmaterialized_pdf_visual: options.allow_unmaterialized_pdf_visual,
  })
  if (!Array.isArray(value.components) || (availability === "documented" && value.components.length === 0)) {
    throw new Error("documented typical-application evidence must list the application components")
  }
  const seen_components = new Set<string>()
  const components_with_sourced_part_numbers = new Set<string>()
  const components_with_sourced_footprints = new Set<string>()
  const components = value.components.map((component, index) => {
    if (!isRecord(component)) {
      throw new Error(`typical application components[${index}] must be an object`)
    }
    assertOnlyKeys(
      component,
      [
        "reference",
        "kind",
        "value",
        "purpose",
        "manufacturer_part_number",
        "footprint",
        "source_references",
        "footprint_source_references",
      ],
      `typical application components[${index}]`,
    )
    const reference = requiredText(component.reference, `components[${index}].reference`)
    if (seen_components.has(componentReferenceKey(reference))) {
      throw new Error(`typical application component ${reference} is listed more than once`)
    }
    seen_components.add(componentReferenceKey(reference))
    let component_source_references: ApplicationSourceReference[] | undefined
    if (component.source_references !== undefined) {
      component_source_references = parseApplicationSourceReferences({
        value: component.source_references,
        label: `components[${index}].source_references`,
        allow_unmaterialized_pdf_visual: options.allow_unmaterialized_pdf_visual,
      })
    }
    let footprint_source_references: ApplicationSourceReference[] | undefined
    if (component.footprint_source_references !== undefined) {
      footprint_source_references = parseApplicationSourceReferences({
        value: component.footprint_source_references,
        label: `components[${index}].footprint_source_references`,
        allow_unmaterialized_pdf_visual: options.allow_unmaterialized_pdf_visual,
      })
    }
    const parseComponentText = (component_value: unknown, field: string) =>
      optionalSourcedText({
        value: component_value,
        label: `components[${index}].${field}`,
        allow_unmaterialized_pdf_visual: options.allow_unmaterialized_pdf_visual,
      })
    const parsed_value = parseComponentText(component.value, "value")
    const parsed_purpose = parseComponentText(component.purpose, "purpose")
    const parsed_part_number = parseComponentText(
      component.manufacturer_part_number,
      "manufacturer_part_number",
    )
    const parsed_footprint = parseComponentText(component.footprint, "footprint")
    if (hasExactPartNumberSource(component_source_references, parsed_part_number.sources)) {
      components_with_sourced_part_numbers.add(componentReferenceKey(reference))
    }
    if (hasFootprintSource(footprint_source_references, parsed_footprint.sources)) {
      components_with_sourced_footprints.add(componentReferenceKey(reference))
    }
    component_source_references = mergeSourceReferences(
      component_source_references,
      parsed_value.sources,
      parsed_purpose.sources,
      parsed_part_number.sources,
    )
    footprint_source_references = mergeSourceReferences(footprint_source_references, parsed_footprint.sources)
    return {
      reference,
      kind: requiredText(component.kind, `components[${index}].kind`),
      ...(parsed_value.value === undefined ? {} : { value: parsed_value.value }),
      ...(parsed_purpose.value === undefined ? {} : { purpose: parsed_purpose.value }),
      ...(parsed_part_number.value === undefined
        ? {}
        : { manufacturer_part_number: parsed_part_number.value }),
      ...(parsed_footprint.value === undefined ? {} : { footprint: parsed_footprint.value }),
      ...(component_source_references ? { source_references: component_source_references } : {}),
      ...(footprint_source_references ? { footprint_source_references } : {}),
    }
  })
  if (
    !Array.isArray(value.connections) ||
    (availability === "documented" && value.connections.length === 0)
  ) {
    throw new Error("documented typical-application evidence must list the application connections")
  }
  const seen_nets = new Set<string>()
  const seen_endpoints = new Map<string, string>()
  const connections = value.connections.map((connection, index) => {
    if (!isRecord(connection)) {
      throw new Error(`typical application connections[${index}] must be a structured net object`)
    }
    assertOnlyKeys(connection, ["net", "pins"], `typical application connections[${index}]`)
    const net_path = `connections[${index}].net`
    const net = canonicalizeApplicationEndpoint(requiredText(connection.net, net_path), net_path)
    if (net.includes(".")) {
      throw new Error(
        `typical application ${net_path} must be a bare net identity, not component.port syntax`,
      )
    }
    if (seen_nets.has(net.toLowerCase())) {
      throw new Error(`typical application net ${net} is listed more than once`)
    }
    seen_nets.add(net.toLowerCase())
    if (!Array.isArray(connection.pins) || connection.pins.length < 2) {
      throw new Error(`typical application connections[${index}].pins must list at least two pins`)
    }
    const pins = connection.pins.map((pin, pin_index) => {
      const endpoint_path = `connections[${index}].pins[${pin_index}]`
      const endpoint = canonicalizeApplicationEndpoint(requiredText(pin, endpoint_path), endpoint_path)
      // Bare tokens are explicit external rail/terminal identities. They are
      // retained in the canonical plan so an independent reviewer can detect a
      // VIN/VOUT/GND mix-up instead of comparing only the internal component
      // endpoints.
      const endpoint_key = endpoint.toLowerCase()
      const earlier_net = seen_endpoints.get(endpoint_key)
      if (earlier_net) {
        throw new Error(
          `typical application endpoint ${endpoint} is listed on both ${earlier_net} and ${net}`,
        )
      }
      seen_endpoints.set(endpoint_key, net)
      return endpoint
    })
    if (!pins.some((endpoint) => endpoint.includes("."))) {
      throw new Error(
        `typical application connections[${index}].pins must include at least one component.port endpoint`,
      )
    }
    return { net, pins }
  })
  const canonical_plan = canonicalizeTypicalApplicationPlan(
    {
      version: 4,
      availability: availability as TypicalApplicationPlan["availability"],
      ...(pcb_implementation ? { pcb_implementation } : {}),
      title: requiredText(value.title, "typical application title"),
      description: requiredText(value.description, "typical application description"),
      source_references,
      components,
      connections,
    },
    options.target_identity,
  )
  const component_names = new Set(
    canonical_plan.components.map((component) => componentReferenceKey(component.reference)),
  )
  for (const connection of canonical_plan.connections) {
    for (const endpoint of connection.pins) {
      if (!endpoint.includes(".")) continue
      const component_name = componentReferenceKey(endpoint.slice(0, endpoint.indexOf(".")))
      if (!component_names.has(component_name)) {
        throw new Error(`typical application endpoint ${endpoint} references an unlisted component`)
      }
    }
  }
  if (availability === "documented") {
    const connected_component_names = new Set(
      canonical_plan.connections.flatMap((connection) =>
        connection.pins.flatMap((endpoint) => {
          const separator = endpoint.indexOf(".")
          return separator > 0 ? [componentReferenceKey(endpoint.slice(0, separator))] : []
        }),
      ),
    )
    for (const component of canonical_plan.components) {
      if (!connected_component_names.has(componentReferenceKey(component.reference))) {
        throw new Error(
          `typical application component ${component.reference} is unconnected; every listed component must appear in at least one connection`,
        )
      }
    }
  }
  if (pcb_implementation === "verified") {
    for (const component of canonical_plan.components) {
      if (normalizedIdentifier(component.reference) === "u1" || isInterfaceOnlyComponent(component)) {
        continue
      }
      if (
        !component.manufacturer_part_number ||
        !components_with_sourced_part_numbers.has(componentReferenceKey(component.reference))
      ) {
        throw new Error(
          `verified PCB component ${component.reference} must include a datasheet-sourced manufacturer_part_number from pdf_text or pdf_visual; calculated and package_standard references cannot identify an exact orderable part`,
        )
      }
      if (
        !component.footprint ||
        !components_with_sourced_footprints.has(componentReferenceKey(component.reference))
      ) {
        throw new Error(
          `verified PCB component ${component.reference} must include a datasheet- or package-standard-sourced footprint; calculated references cannot verify a footprint`,
        )
      }
    }
  }
  if (availability === "not_present" && (components.length > 0 || connections.length > 0)) {
    throw new Error("not_present typical-application evidence must have empty components and connections")
  }
  const searched_sections = optionalTextArray(
    value.searched_sections,
    "typical-application searched_sections",
  )
  if (availability === "not_present" && searched_sections.length === 0) {
    throw new Error("not_present typical-application evidence must list searched_sections")
  }
  return {
    ...canonical_plan,
    ...(searched_sections.length > 0 ? { searched_sections } : {}),
  }
}

export function parseTypicalApplicationPlan(
  value: unknown,
  target_identity?: ApplicationTargetIdentityInput,
): TypicalApplicationPlan {
  return parseTypicalApplicationPlanWithOptions(value, {
    target_identity,
    allow_unmaterialized_pdf_visual: false,
  })
}

/** Parse an isolated agent candidate before the server renders and binds its cited PDF pages. */
export function parseUnmaterializedTypicalApplicationPlan(value: unknown): TypicalApplicationPlan {
  return parseTypicalApplicationPlanWithOptions(value, {
    allow_unmaterialized_pdf_visual: true,
  })
}
