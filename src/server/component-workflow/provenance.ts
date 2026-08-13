import { lstat, readFile, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join, relative, resolve } from "node:path"
import { repositoryRoot } from "../paths/repository-paths"
import { getPinnedTscircuitVersion } from "../runtime-versions"
import { getRuntimeSourceCommit } from "../runtime-source-commit"
import { isRecord } from "./application-plan"
import {
  applicationEvidencePrompt,
  applicationPlanningPrompt,
  applicationPrompt,
  componentPrompt,
  evidencePrompt,
} from "./prompts"
import { APPLICATION_EVIDENCE_GUIDE_SHA256, COMPONENT_EVIDENCE_GUIDE_SHA256 } from "./evidence-schema"

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

async function readInstalledPackageVersion(package_name: string): Promise<string> {
  const package_path = resolve(repositoryRoot, "node_modules", package_name, "package.json")
  const value: unknown = JSON.parse(await readFile(package_path, "utf8"))
  return isRecord(value) && typeof value.version === "string" ? value.version : "unknown"
}

async function workflowSourceHash(): Promise<string> {
  const roots = [resolve(repositoryRoot, "src", "server"), resolve(repositoryRoot, "src", "shared")]
  const files: string[] = [resolve(repositoryRoot, "package.json"), resolve(repositoryRoot, "bun.lock")]
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Workflow source contains a symlink: ${path}`)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(path)
      else throw new Error(`Workflow source contains a special file: ${path}`)
      if (files.length > 4_096) throw new Error("Workflow source exceeds the 4096-file hash limit")
    }
  }
  for (const root of roots) await visit(root)

  const hash = createHash("sha256")
  let total_bytes = 0
  for (const path of files.sort((left, right) => left.localeCompare(right))) {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Workflow source is not a regular file: ${path}`)
    }
    total_bytes += metadata.size
    if (total_bytes > 64 * 1024 * 1024) throw new Error("Workflow source exceeds the 64 MiB hash limit")
    const name = relative(repositoryRoot, path).replaceAll("\\", "/")
    const bytes = await readFile(path)
    hash.update(`${name.length}:${name}:${bytes.byteLength}:`)
    hash.update(bytes)
  }
  return hash.digest("hex")
}

export async function collectJobProvenance(input: {
  job_dir: string
  additional_instructions?: string
}): Promise<import("@/shared/job-types").JobProvenance> {
  const [
    datasheet,
    dependency_lock,
    tsci_agent_version,
    tscircuit_version,
    source_commit,
    workflow_source_sha256,
  ] = await Promise.all([
    readFile(join(input.job_dir, "datasheet.pdf")),
    readFile(resolve(repositoryRoot, "bun.lock")).catch(() => undefined),
    readInstalledPackageVersion("tsci-agent").catch(() => "unknown"),
    getPinnedTscircuitVersion(),
    getRuntimeSourceCommit(),
    workflowSourceHash(),
  ])
  return {
    source_commit,
    workflow_source_sha256,
    evidence_contract_sha256: sha256(
      `${COMPONENT_EVIDENCE_GUIDE_SHA256}:${APPLICATION_EVIDENCE_GUIDE_SHA256}`,
    ),
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
        `${applicationEvidencePrompt({
          additional_instructions: input.additional_instructions,
        })}\n${applicationPrompt({
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
        })}`,
      ),
      application_planning: sha256(applicationPlanningPrompt()),
    },
  }
}
