import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { restoreJobDirectory } from "@/server/job-restorer/restore-job-directory"
import { JobStore } from "@/server/job-store"

test("restart never restores an invalid typical application that was not published", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "unpublished-application-"))
  const original_store = new JobStore()
  original_store.createJob({
    job_id: "interrupted-job",
    job_dir,
    file_name: "sensor.pdf",
  })
  original_store.updateJob("interrupted-job", {
    display_status: "building",
    component_ready: true,
    typical_application_title: "Unpublished candidate",
    validation: {
      evidence: "passed",
      component_build: "passed",
      component_drc: "passed",
      footprint: "passed",
      pinout: "passed",
      component_schematic: "passed",
      component_visual: "inconclusive",
      application_build: "failed",
      application_connectivity: "failed",
      application_schematic: "failed",
      application_visual: "failed",
    },
  })
  await mkdir(join(job_dir, "dist", "typical-application"), { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nfixture"),
    Bun.write(join(job_dir, "index.circuit.tsx"), "export default () => <chip />\n"),
    Bun.write(
      join(job_dir, "component.circuit.json"),
      JSON.stringify([{ type: "source_component", source_component_id: "u1" }]),
    ),
    Bun.write(join(job_dir, "typical-application.circuit.tsx"), "const unfinished = <board />\n"),
    Bun.write(
      join(job_dir, "dist", "typical-application", "circuit.json"),
      JSON.stringify([{ type: "source_component", source_component_id: "invalid-candidate" }]),
    ),
  ])

  try {
    const restored_store = new JobStore()
    const restored = await restoreJobDirectory({
      job_id: "interrupted-job",
      job_dir,
      job_store: restored_store,
    })

    expect(restored?.display_status).toBe("failed")
    expect(restored?.component_ready).toBe(true)
    expect(restored?.component_code).toContain("export default")
    expect(restored?.typical_application_title).toBeUndefined()
    expect(restored?.evidence_available).toBe(false)
    expect(restored?.typical_application_code).toBeUndefined()
    expect(restored?.typical_application_circuit_json).toBeUndefined()
    expect(restored?.error_message).toContain("server restarted")
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})
