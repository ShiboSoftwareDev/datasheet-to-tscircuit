import { validateModelSource } from "../modeling/model-artifacts"
import { IDENTIFIER_PATTERN, SPICE_NODE_PATTERN } from "./identifiers"
import type { ValidationCollector } from "./parse-helpers"
import type { ValidationContext } from "./types"

export interface ValidationModelDefinition {
  version: 1
  entry_name: string
  pins: Array<{ component_pin: string; spice_node: string }>
}

export function getValidationModelDefinition(context: ValidationContext): ValidationModelDefinition {
  return context.manifest ?? context.model_interface
}

export function validateModelDefinition(
  context: ValidationContext,
  collector: ValidationCollector,
): ValidationModelDefinition {
  const model = getValidationModelDefinition(context)
  const context_path = context.manifest ? "manifest" : "model_interface"
  if (model.version !== 1) collector.add(`${context_path}.version`, "unsupported_version", "must be 1")
  if (!IDENTIFIER_PATTERN.test(model.entry_name)) {
    collector.add(
      `${context_path}.entry_name`,
      "unsafe_identifier",
      "must be an executable-safe SPICE identifier",
    )
  }
  if (context.manifest?.model_file !== undefined && context.manifest.model_file !== "model.lib") {
    collector.add(`${context_path}.model_file`, "invalid_model_file", 'must be "model.lib"')
  }
  if (context.manifest?.simulator !== undefined && context.manifest.simulator !== "ngspice") {
    collector.add(`${context_path}.simulator`, "invalid_simulator", 'must be "ngspice"')
  }
  if (model.pins.length === 0) {
    collector.add(`${context_path}.pins`, "missing_pins", "must contain at least one pin mapping")
  }
  const spice_nodes = new Set<string>()
  const component_pins = new Set<string>()
  model.pins.forEach((pin, index) => {
    if (!SPICE_NODE_PATTERN.test(pin.spice_node)) {
      collector.add(
        `${context_path}.pins[${index}].spice_node`,
        "unsafe_identifier",
        "must contain only letters, digits, and underscores",
      )
    }
    if (spice_nodes.has(pin.spice_node)) {
      collector.add(`${context_path}.pins[${index}].spice_node`, "duplicate_id", "must be unique")
    }
    if (!pin.component_pin) {
      collector.add(
        `${context_path}.pins[${index}].component_pin`,
        "invalid_string",
        "must be a non-empty string",
      )
    } else if (component_pins.has(pin.component_pin)) {
      collector.add(`${context_path}.pins[${index}].component_pin`, "duplicate_id", "must be unique")
    }
    spice_nodes.add(pin.spice_node)
    component_pins.add(pin.component_pin)
  })
  if (context.model_source !== undefined) {
    try {
      validateModelSource(context.model_source, model)
    } catch (error) {
      collector.add(
        "model_source",
        "invalid_model_source",
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  return model
}
