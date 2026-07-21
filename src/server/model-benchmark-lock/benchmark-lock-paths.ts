import { createHash } from "node:crypto"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function hashContent(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex")
}

export function getLockRoot(model_dir: string): string {
  return join(dirname(model_dir), ".model-benchmark-lock")
}

export function getLockFile(model_dir: string): string {
  return join(getLockRoot(model_dir), "lock.json")
}

export function getReferenceImageContractFile(model_dir: string): string {
  return join(getLockRoot(model_dir), "reference-image-contract.json")
}

export function resolveWorkspaceFile(model_dir: string, file: string): string {
  if (isAbsolute(file)) throw new Error(`Locked benchmark file must be relative: ${file}`)
  const resolved_root = resolve(model_dir)
  const resolved_file = resolve(resolved_root, file)
  if (!resolved_file.startsWith(`${resolved_root}${sep}`)) {
    throw new Error(`Locked benchmark file escapes the model workspace: ${file}`)
  }
  return resolved_file
}

export function assertEvidenceFile(model_dir: string, file: string): void {
  const evidence_root = resolve(model_dir, "evidence")
  const resolved_file = resolve(model_dir, file)
  if (!resolved_file.startsWith(`${evidence_root}${sep}`)) {
    throw new Error(`Locked benchmark evidence must stay under evidence/: ${file}`)
  }
}
