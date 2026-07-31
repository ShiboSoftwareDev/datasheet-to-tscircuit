import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { repositoryRoot } from "../paths/repository-paths"
import { getPinnedTscircuitVersion } from "../runtime-versions"
import { getRuntimeSourceCommit } from "../runtime-source-commit"
import { isRecord } from "./application-plan"
import { applicationPrompt, componentPrompt, evidencePrompt } from "./prompts"

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

async function readInstalledPackageVersion(package_name: string): Promise<string> {
  const package_path = resolve(repositoryRoot, "node_modules", package_name, "package.json")
  const value: unknown = JSON.parse(await readFile(package_path, "utf8"))
  return isRecord(value) && typeof value.version === "string" ? value.version : "unknown"
}

export async function collectJobProvenance(input: {
  job_dir: string
  additional_instructions?: string
}): Promise<import("@/shared/job-types").JobProvenance> {
  const [datasheet, dependency_lock, tsci_agent_version, tscircuit_version, source_commit] =
    await Promise.all([
      readFile(join(input.job_dir, "datasheet.pdf")),
      readFile(resolve(repositoryRoot, "bun.lock")).catch(() => undefined),
      readInstalledPackageVersion("tsci-agent").catch(() => "unknown"),
      getPinnedTscircuitVersion(),
      getRuntimeSourceCommit(),
    ])
  return {
    source_commit,
    bun_version: Bun.version,
    tscircuit_version,
    tsci_agent_version,
    agent_model: process.env.TSCI_AGENT_MODEL ?? "agent-default",
    agent_settings: process.env.TSCI_AGENT_SETTINGS ?? "agent-default",
    datasheet_sha256: sha256(datasheet),
    ...(dependency_lock ? { dependency_lock_sha256: sha256(dependency_lock) } : {}),
    prompt_sha256: {
      evidence: sha256(evidencePrompt({ additional_instructions: input.additional_instructions })),
      component_generation: sha256(componentPrompt({})),
      typical_application: sha256(
        applicationPrompt({
          plan: {
            version: 4,
            availability: "documented",
            pcb_implementation: "schematic_only",
            title: "prompt fingerprint",
            description: "prompt fingerprint",
            source_references: [{ page: 1 }],
            components: [],
            connections: [],
          },
        }),
      ),
    },
  }
}
