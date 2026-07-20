import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

let pinned_tscircuit_version: Promise<string> | undefined

export function getPinnedTscircuitVersion(): Promise<string> {
  pinned_tscircuit_version ??= readFile(resolve(import.meta.dir, "../..", "package.json"), "utf8").then(
    (text) => {
      const package_json: unknown = JSON.parse(text)
      if (
        typeof package_json !== "object" ||
        package_json === null ||
        !("dependencies" in package_json) ||
        typeof package_json.dependencies !== "object" ||
        package_json.dependencies === null ||
        !("tscircuit" in package_json.dependencies) ||
        typeof package_json.dependencies.tscircuit !== "string"
      ) {
        throw new Error("Root package.json must declare dependencies.tscircuit")
      }
      const version = package_json.dependencies.tscircuit
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error(
          `Root package.json dependencies.tscircuit must be an exact version, received ${JSON.stringify(version)}`,
        )
      }
      return version
    },
  )
  return pinned_tscircuit_version
}
