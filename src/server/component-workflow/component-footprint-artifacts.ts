import { join } from "node:path"
import type { ComponentFootprintCatalog, ComponentFootprintVariant } from "../component-evidence"

export function componentBuildSourceRelativePath(
  catalog: ComponentFootprintCatalog,
  footprint: ComponentFootprintVariant,
): string {
  return footprint.footprint_id === catalog.default_footprint_id
    ? "index.circuit.tsx"
    : `component-variant-${footprint.footprint_id}.circuit.tsx`
}

export function componentPublishedCircuitJsonRelativePath(footprint_id: string): string {
  return join("component-variants", `${footprint_id}.circuit.json`)
}

export function componentBuildResultRelativePath(
  catalog: ComponentFootprintCatalog,
  footprint: ComponentFootprintVariant,
): string {
  return footprint.footprint_id === catalog.default_footprint_id
    ? "component-build.json"
    : join("component-variant-builds", `${footprint.footprint_id}.json`)
}

export function componentValidationResultRelativePath(
  catalog: ComponentFootprintCatalog,
  footprint: ComponentFootprintVariant,
): string {
  return footprint.footprint_id === catalog.default_footprint_id
    ? "component-validation.json"
    : join("component-variant-validations", `${footprint.footprint_id}.json`)
}
