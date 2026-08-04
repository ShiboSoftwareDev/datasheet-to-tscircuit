import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { atomicWriteJsonSync, type AtomicWriteResult } from "../../infrastructure/persistence/atomic-write"
import { MODEL_PUBLICATION_FILE } from "./constants"
import { assertPublicationOwnership, parseModelPublication } from "./pointer-schema"
import { readModelPublication } from "./reader"
import type { ModelPublicationCommit, ResolvedModelPublication } from "./types"

export async function resolveAcceptedModelPublication(
  model_dir: string,
  expected_job_id: string,
): Promise<ResolvedModelPublication | undefined> {
  const publication = await readModelPublication(resolve(model_dir, ".."), expected_job_id)
  if (!publication) return undefined
  const expected_root = resolve(model_dir, "accepted-revisions")
  const from_root = relative(expected_root, publication.accepted_model_dir)
  if (!from_root || from_root === ".." || from_root.startsWith(`..${sep}`) || isAbsolute(from_root)) {
    throw new Error(`${MODEL_PUBLICATION_FILE} does not select a snapshot in this model workspace`)
  }
  return publication
}

export function commitModelPublication(
  job_dir: string,
  expected_job_id: string,
  commit: ModelPublicationCommit,
): AtomicWriteResult {
  // Validate the exact pointer shape before the atomic rename makes it public.
  const parsed = parseModelPublication(commit)
  if (parsed.version !== 3) {
    throw new Error("The model publication writer accepts only fresh version 3 publications")
  }
  assertPublicationOwnership(parsed, expected_job_id)
  return atomicWriteJsonSync(join(job_dir, MODEL_PUBLICATION_FILE), parsed)
}
