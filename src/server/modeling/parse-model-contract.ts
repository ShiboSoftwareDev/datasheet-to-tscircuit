import { parseModelCharacterization } from "./parse-model-characterization"
import { parseApplicationFixtureContract } from "./application-fixture-contract"
import type { ModelContract, ModelInterface } from "./types"

const SPICE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SELECTOR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

type UnknownRecord = Record<string, unknown>

function record(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as UnknownRecord
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`)
  return value
}

function exactKeys(value: UnknownRecord, keys: readonly string[], path: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`${path} contains unknown field ${JSON.stringify(unknown[0])}`)
}

function requireUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${path} must contain unique values`)
}

export function parseModelInterface(value: unknown, path = "model-interface.json"): ModelInterface {
  const model_interface = record(value, path)
  exactKeys(model_interface, ["version", "part_number", "entry_name", "pins"], path)
  if (model_interface.version !== 1) throw new Error(`${path}.version must be 1`)
  const part_number = nonEmptyString(model_interface.part_number, `${path}.part_number`)
  const entry_name = nonEmptyString(model_interface.entry_name, `${path}.entry_name`)
  if (!SPICE_IDENTIFIER_PATTERN.test(entry_name)) {
    throw new Error(`${path}.entry_name must be a safe SPICE identifier`)
  }
  if (!Array.isArray(model_interface.pins) || model_interface.pins.length === 0) {
    throw new Error(`${path}.pins must be a non-empty array`)
  }
  const pins = model_interface.pins.map((pin_value, index) => {
    const pin_path = `${path}.pins[${index}]`
    const pin = record(pin_value, pin_path)
    exactKeys(
      pin,
      ["physical_pin", "component_pin", "source_port_id", "spice_node", "labels", "role"],
      pin_path,
    )
    if (!Array.isArray(pin.labels) || pin.labels.some((label) => typeof label !== "string")) {
      throw new Error(`${pin_path}.labels must be an array of strings`)
    }
    const component_pin = nonEmptyString(pin.component_pin, `${pin_path}.component_pin`)
    if (!SELECTOR_PATTERN.test(component_pin)) {
      throw new Error(`${pin_path}.component_pin must be a selector-safe tscircuit port hint`)
    }
    const spice_node = nonEmptyString(pin.spice_node, `${pin_path}.spice_node`)
    if (!SPICE_IDENTIFIER_PATTERN.test(spice_node)) {
      throw new Error(`${pin_path}.spice_node must be a safe SPICE identifier`)
    }
    return {
      physical_pin: nonEmptyString(pin.physical_pin, `${pin_path}.physical_pin`),
      component_pin,
      source_port_id: nonEmptyString(pin.source_port_id, `${pin_path}.source_port_id`),
      spice_node,
      labels: [...pin.labels] as string[],
      role: nonEmptyString(pin.role, `${pin_path}.role`),
    }
  })
  requireUnique(
    pins.map(({ physical_pin }) => physical_pin),
    `${path} physical pins`,
  )
  requireUnique(
    pins.map(({ component_pin }) => component_pin),
    `${path} component pins`,
  )
  requireUnique(
    pins.map(({ source_port_id }) => source_port_id),
    `${path} source ports`,
  )
  requireUnique(
    pins.map(({ spice_node }) => spice_node),
    `${path} SPICE nodes`,
  )
  return { version: 1, part_number, entry_name, pins }
}

export interface ParseModelContractOptions {
  characterization_policy?: "compatibility" | "fresh"
  reject_unknown_characterization_fields?: boolean
}

export function parseModelContract(value: unknown, options: ParseModelContractOptions = {}): ModelContract {
  const path = "model-contract.json"
  const contract = record(value, path)
  exactKeys(contract, ["version", "interface", "characterization", "application_fixture"], path)
  if (contract.version !== 1) throw new Error(`${path}.version must be 1`)
  return {
    version: 1,
    interface: parseModelInterface(contract.interface, `${path}.interface`),
    characterization: parseModelCharacterization(contract.characterization, {
      policy: options.characterization_policy,
      reject_unknown_fields: options.reject_unknown_characterization_fields,
    }),
    ...(contract.application_fixture === undefined
      ? {}
      : {
          application_fixture: parseApplicationFixtureContract(
            contract.application_fixture,
            `${path}.application_fixture`,
          ),
        }),
  }
}

/** Parse a contract that is about to participate in the executable model workflow. */
export function parseFreshModelContract(value: unknown): ModelContract {
  const contract = parseModelContract(value, {
    characterization_policy: "fresh",
    reject_unknown_characterization_fields: true,
  })
  if (!contract.characterization.requirements.some(({ support }) => support.status === "modeled")) {
    throw new Error("Fresh executable model contract must contain at least one modeled requirement")
  }
  return contract
}
