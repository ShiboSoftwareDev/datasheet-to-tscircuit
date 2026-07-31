import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasCommittedEvidence, writeEvidenceCommit } from "@/server/component-workflow/evidence-commit"
import { restoreJobDirectory } from "@/server/job-restorer/restore-job-directory"
import { JobStore } from "@/server/job-store"

const png_bytes = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
)

test("restart exposes evidence only after the complete evidence set is committed", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "committed-evidence-"))
  await mkdir(join(job_dir, "visual-reference"), { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nevidence fixture"),
    Bun.write(join(job_dir, "component-evidence.json"), '{"version":1}\n'),
    Bun.write(join(job_dir, "footprint-plan.json"), '{"version":1}\n'),
    Bun.write(join(job_dir, "component-schematic-plan.json"), '{"version":1}\n'),
    Bun.write(
      join(job_dir, "typical-application-plan.json"),
      '{"version":4,"title":"Committed reference application"}\n',
    ),
    Bun.write(join(job_dir, "visual-reference", "land-pattern.png"), png_bytes),
  ])

  try {
    expect(await hasCommittedEvidence(job_dir)).toBe(false)
    new JobStore().createJob({
      job_id: "uncommitted-evidence",
      job_dir,
      file_name: "evidence.pdf",
    })
    const uncommitted = await restoreJobDirectory({
      job_id: "uncommitted-evidence",
      job_dir,
      job_store: new JobStore(),
    })
    expect(uncommitted?.evidence_available).toBe(false)
    expect(uncommitted?.typical_application_title).toBeUndefined()

    await writeEvidenceCommit(job_dir)
    expect(await hasCommittedEvidence(job_dir)).toBe(true)
    new JobStore().createJob({
      job_id: "committed-evidence",
      job_dir,
      file_name: "evidence.pdf",
    })
    const committed = await restoreJobDirectory({
      job_id: "committed-evidence",
      job_dir,
      job_store: new JobStore(),
    })
    expect(committed?.evidence_available).toBe(true)
    expect(committed?.typical_application_title).toBe("Committed reference application")

    await Bun.write(join(job_dir, "component-evidence.json"), '{"version":2}\n')
    expect(await hasCommittedEvidence(job_dir)).toBe(false)
    new JobStore().createJob({
      job_id: "tampered-evidence",
      job_dir,
      file_name: "evidence.pdf",
    })
    const tampered = await restoreJobDirectory({
      job_id: "tampered-evidence",
      job_dir,
      job_store: new JobStore(),
    })
    expect(tampered?.evidence_available).toBe(false)
    expect(tampered?.typical_application_title).toBeUndefined()
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})
