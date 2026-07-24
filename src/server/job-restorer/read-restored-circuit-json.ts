import { join } from "node:path"
import type { Job, JobLog } from "@/shared/job-types"
import { selectPreferredComponentCircuitJson } from "../component-circuit-json"
import { readJson } from "./read-persisted-logs"

export async function readRestoredCircuitJson(
  job_dir: string,
  artifact: "component" | "typical_application",
): Promise<Job["circuit_json"] | undefined> {
  const candidates =
    artifact === "component"
      ? [
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
