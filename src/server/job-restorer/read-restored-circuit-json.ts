import { join } from "node:path"
import type { Job, JobLog } from "@/shared/job-types"
import { selectPreferredComponentCircuitJson } from "../component-circuit-json"
import { readVerifiedPublicationArtifact, type ResolvedModelPublication } from "../modeling"
import { readJson } from "./read-persisted-logs"

export async function readRestoredCircuitJson(
  job_dir: string,
  artifact: "component" | "typical_application",
  publication?: ResolvedModelPublication,
  options: { base_component_only?: boolean } = {},
): Promise<Job["circuit_json"] | undefined> {
  if (artifact === "component" && publication) {
    const bytes = await readVerifiedPublicationArtifact({
      publication,
      bundle: "published_component",
      relative_path: "component.circuit.json",
      max_bytes: 16 * 1024 * 1024,
    })
    return selectPreferredComponentCircuitJson(JSON.parse(new TextDecoder().decode(bytes)))
  }
  const candidates =
    artifact === "component"
      ? options.base_component_only
        ? [join(job_dir, "component.circuit.json"), join(job_dir, "dist", "index", "circuit.json")]
        : [
            join(job_dir, "spice", "component-with-model.circuit.json"),
            join(job_dir, "spice", "dist", "component-with-model", "circuit.json"),
            join(job_dir, "dist", "spice", "component-with-model", "circuit.json"),
            join(job_dir, "component.circuit.json"),
            join(job_dir, "dist", "index", "circuit.json"),
          ]
      : [join(job_dir, "dist", "typical-application", "circuit.json")]
  const values = await Promise.all(candidates.map((candidate) => readJson(candidate)))
  return selectPreferredComponentCircuitJson(...values)
}

export function inferFileName(logs: JobLog[], job_id: string): string {
  for (const log of logs) {
    const match = log.message.match(/Uploaded (.+) \(\d+ bytes\)\./)
    if (match?.[1]) return match[1]
  }
  return `${job_id}.pdf`
}
