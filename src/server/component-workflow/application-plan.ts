import type { ExpectedApplicationConnection } from "../job-artifact-validator"

function normalizedIdentifier(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export interface TypicalApplicationPlan {
  version: 4
  availability: "documented" | "not_present"
  pcb_implementation?: "verified" | "schematic_only"
  title: string
  description: string
  source_references: Array<{ page: number; figure?: string }>
  searched_sections?: string[]
  components: Array<{
    reference: string
    kind: string
    value?: string
    purpose?: string
    manufacturer_part_number?: string
    footprint?: string
    source_references?: Array<{ page: number; figure?: string }>
    footprint_source_references?: Array<{ page: number; figure?: string }>
  }>
  connections: ExpectedApplicationConnection[]
}

function isInterfaceOnlyComponent(component: TypicalApplicationPlan["components"][number]): boolean {
  const kind = component.kind
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
  return /^(?:external|power|input|output|supply|net).*(?:port|terminal)$/.test(kind)
}

function isTargetApplicationComponent(
  component: TypicalApplicationPlan["components"][number],
  target_part_number?: string,
): boolean {
  const target = normalizedIdentifier(target_part_number)
  if (target.length < 4) return false
  const reference = normalizedIdentifier(component.reference)
  const value = normalizedIdentifier(component.value)
  return reference.startsWith(target) || value.startsWith(target)
}

function canonicalizeTypicalApplicationPlan(
  plan: TypicalApplicationPlan,
  target_part_number?: string,
): TypicalApplicationPlan {
  const removed_references = new Set(
    plan.components
      .filter(isInterfaceOnlyComponent)
      .map((component) => component.reference.trim().toLowerCase()),
  )
  const target_references = new Set(
    plan.components
      .filter((component) => isTargetApplicationComponent(component, target_part_number))
      .map((component) => normalizedIdentifier(component.reference)),
  )
  const referenced_component_names = new Set(
    plan.connections.flatMap((connection) =>
      connection.pins.map((endpoint) => normalizedIdentifier(endpoint.slice(0, endpoint.indexOf(".")))),
    ),
  )
  if (target_references.size === 0 && referenced_component_names.has("u1") && target_part_number) {
    target_references.add("u1")
  }

  const canonical_components = plan.components
    .filter((component) => !isInterfaceOnlyComponent(component))
    .map((component) =>
      target_references.has(normalizedIdentifier(component.reference))
        ? { ...component, reference: "U1" }
        : component,
    )
  if (
    target_references.has("u1") &&
    target_part_number &&
    !canonical_components.some((component) => normalizedIdentifier(component.reference) === "u1")
  ) {
    canonical_components.unshift({
      reference: "U1",
      kind: "integrated_circuit",
      value: target_part_number,
      purpose: "Target component",
    })
  }

  const connections = plan.connections.flatMap((connection) => {
    const pins = connection.pins
      .filter((endpoint) => {
        const separator = endpoint.indexOf(".")
        return !removed_references.has(endpoint.slice(0, separator).trim().toLowerCase())
      })
      .map((endpoint) => {
        const separator = endpoint.indexOf(".")
        const reference = endpoint.slice(0, separator)
        return target_references.has(normalizedIdentifier(reference))
          ? `U1.${endpoint.slice(separator + 1)}`
          : endpoint
      })
    return pins.length >= 2 ? [{ ...connection, pins }] : []
  })
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

function optionalTextArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((item, index) => requiredText(item, `${label}[${index}]`))
}

export function parseTypicalApplicationPlan(
  value: unknown,
  target_part_number?: string,
): TypicalApplicationPlan {
  if (!isRecord(value) || value.version !== 4) {
    throw new Error("typical-application-plan.json must have version 4")
  }
  const availability = value.availability
  if (availability !== "documented" && availability !== "not_present") {
    throw new Error("typical-application-plan.json must declare documented or not_present")
  }
  const raw_pcb_implementation = value.pcb_implementation
  if (
    raw_pcb_implementation !== undefined &&
    raw_pcb_implementation !== "verified" &&
    raw_pcb_implementation !== "schematic_only"
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
  if (!Array.isArray(value.source_references) || value.source_references.length === 0) {
    throw new Error("typical-application-plan.json must cite at least one datasheet page")
  }
  const source_references = value.source_references.map((source, index) => {
    if (!isRecord(source) || !Number.isInteger(source.page) || (source.page as number) < 1) {
      throw new Error(`typical application source_references[${index}].page must be a positive integer`)
    }
    return {
      page: source.page as number,
      ...(source.figure === undefined
        ? {}
        : { figure: requiredText(source.figure, `source_references[${index}].figure`) }),
    }
  })
  if (!Array.isArray(value.components) || (availability === "documented" && value.components.length === 0)) {
    throw new Error("documented typical-application evidence must list the application components")
  }
  const seen_components = new Set<string>()
  const components = value.components.map((component, index) => {
    if (!isRecord(component)) {
      throw new Error(`typical application components[${index}] must be an object`)
    }
    const reference = requiredText(component.reference, `components[${index}].reference`)
    if (seen_components.has(reference.toLowerCase())) {
      throw new Error(`typical application component ${reference} is listed more than once`)
    }
    seen_components.add(reference.toLowerCase())
    let component_source_references: Array<{ page: number; figure?: string }> | undefined
    if (component.source_references !== undefined) {
      if (!Array.isArray(component.source_references) || component.source_references.length === 0) {
        throw new Error(`components[${index}].source_references must cite at least one datasheet page`)
      }
      component_source_references = component.source_references.map((source, source_index) => {
        if (!isRecord(source) || !Number.isInteger(source.page) || (source.page as number) < 1) {
          throw new Error(
            `components[${index}].source_references[${source_index}].page must be a positive integer`,
          )
        }
        return {
          page: source.page as number,
          ...(source.figure === undefined
            ? {}
            : {
                figure: requiredText(
                  source.figure,
                  `components[${index}].source_references[${source_index}].figure`,
                ),
              }),
        }
      })
    }
    let footprint_source_references: Array<{ page: number; figure?: string }> | undefined
    if (component.footprint_source_references !== undefined) {
      if (
        !Array.isArray(component.footprint_source_references) ||
        component.footprint_source_references.length === 0
      ) {
        throw new Error(
          `components[${index}].footprint_source_references must cite at least one datasheet page`,
        )
      }
      footprint_source_references = component.footprint_source_references.map((source, source_index) => {
        if (!isRecord(source) || !Number.isInteger(source.page) || (source.page as number) < 1) {
          throw new Error(
            `components[${index}].footprint_source_references[${source_index}].page must be a positive integer`,
          )
        }
        return {
          page: source.page as number,
          ...(source.figure === undefined
            ? {}
            : {
                figure: requiredText(
                  source.figure,
                  `components[${index}].footprint_source_references[${source_index}].figure`,
                ),
              }),
        }
      })
    }
    return {
      reference,
      kind: requiredText(component.kind, `components[${index}].kind`),
      ...(component.value === undefined
        ? {}
        : { value: requiredText(component.value, `components[${index}].value`) }),
      ...(component.purpose === undefined
        ? {}
        : { purpose: requiredText(component.purpose, `components[${index}].purpose`) }),
      ...(component.manufacturer_part_number === undefined
        ? {}
        : {
            manufacturer_part_number: requiredText(
              component.manufacturer_part_number,
              `components[${index}].manufacturer_part_number`,
            ),
          }),
      ...(component.footprint === undefined
        ? {}
        : { footprint: requiredText(component.footprint, `components[${index}].footprint`) }),
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
    const net = requiredText(connection.net, `connections[${index}].net`)
    if (seen_nets.has(net.toLowerCase())) {
      throw new Error(`typical application net ${net} is listed more than once`)
    }
    seen_nets.add(net.toLowerCase())
    if (!Array.isArray(connection.pins) || connection.pins.length < 2) {
      throw new Error(`typical application connections[${index}].pins must list at least two pins`)
    }
    const pins = connection.pins.flatMap((pin, pin_index) => {
      const endpoint = requiredText(pin, `connections[${index}].pins[${pin_index}]`)
      // Bare rail names represent an external schematic interface, not a part pin.
      // Preserve the electrical net among actual component ports and omit the marker.
      if (/^[^\.\s]+$/.test(endpoint)) return []
      if (!/^[^.\s]+\.[^.\s]+$/.test(endpoint)) {
        throw new Error(`connections[${index}].pins[${pin_index}] must use component.port syntax`)
      }
      const endpoint_key = endpoint.toLowerCase()
      const earlier_net = seen_endpoints.get(endpoint_key)
      if (earlier_net) {
        throw new Error(
          `typical application endpoint ${endpoint} is listed on both ${earlier_net} and ${net}`,
        )
      }
      seen_endpoints.set(endpoint_key, net)
      return [endpoint]
    })
    if (pins.length < 2) {
      throw new Error(
        `typical application connections[${index}].pins must retain at least two component.port endpoints after external interfaces are removed`,
      )
    }
    return { net, pins }
  })
  const canonical_plan = canonicalizeTypicalApplicationPlan(
    {
      version: 4,
      availability,
      ...(pcb_implementation ? { pcb_implementation } : {}),
      title: requiredText(value.title, "typical application title"),
      description: requiredText(value.description, "typical application description"),
      source_references,
      components,
      connections,
    },
    target_part_number,
  )
  const component_names = new Set(
    canonical_plan.components.map((component) => component.reference.toLowerCase()),
  )
  for (const connection of canonical_plan.connections) {
    for (const endpoint of connection.pins) {
      const component_name = endpoint.slice(0, endpoint.indexOf(".")).toLowerCase()
      if (!component_names.has(component_name)) {
        throw new Error(`typical application endpoint ${endpoint} references an unlisted component`)
      }
    }
  }
  if (pcb_implementation === "verified") {
    for (const component of canonical_plan.components) {
      if (normalizedIdentifier(component.reference) === "u1") continue
      if (
        !component.manufacturer_part_number ||
        !component.source_references?.length ||
        !component.footprint ||
        !component.footprint_source_references?.length
      ) {
        throw new Error(
          `verified PCB component ${component.reference} must include a datasheet-sourced manufacturer_part_number, source_references, footprint, and footprint_source_references`,
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
