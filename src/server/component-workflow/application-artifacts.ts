import { join } from "node:path"
import type { ApplicationPlanCatalogEntry } from "./application-plan-catalog"

export function applicationSourceRelativePath(entry: ApplicationPlanCatalogEntry): string {
  return entry.origin === "datasheet_reference"
    ? "typical-application.circuit.tsx"
    : `typical-application-${entry.application_id}.circuit.tsx`
}

export function applicationBuildRelativePath(entry: ApplicationPlanCatalogEntry): string {
  return entry.origin === "datasheet_reference"
    ? "application-build.json"
    : join("application-variants", `${entry.application_id}-build.json`)
}

export function applicationValidationRelativePath(entry: ApplicationPlanCatalogEntry): string {
  return entry.origin === "datasheet_reference"
    ? "application-validation.json"
    : join("application-variants", `${entry.application_id}-validation.json`)
}

export function applicationOutputStem(entry: ApplicationPlanCatalogEntry): string {
  return applicationSourceRelativePath(entry).replace(/\.circuit\.tsx$/, "")
}
