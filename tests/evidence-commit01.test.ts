import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFootprintPlanFromEvidence, parseComponentEvidence } from "@/server/component-evidence"
import { createComponentSchematicPlan } from "@/server/component-schematic-plan"
import {
  compareApplicationGraphs,
  parseApplicationConnectivityReview,
} from "@/server/component-workflow/application-connectivity-verification"
import { parseTypicalApplicationPlan } from "@/server/component-workflow/application-plan"
import {
  commitPreparedEvidencePublication,
  hasCommittedEvidence,
  prepareEvidencePublication,
  readCommittedEvidenceSnapshot,
  writeEvidenceCommit,
} from "@/server/component-workflow/evidence-commit"
import {
  compareFootprintGeometry,
  parseFootprintGeometryReview,
} from "@/server/component-workflow/footprint-geometry-verification"
import { restoreJobDirectory } from "@/server/job-restorer/restore-job-directory"
import { JobStore } from "@/server/job-store"

const temporary_directories: string[] = []
const png_bytes = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
)

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function readV3Pointer(job_dir: string): Promise<{
  version: 3
  generation_id: string
  evidence_directory: string
  files: Record<string, { sha256: string; size_bytes: number }>
}> {
  const pointer = (await Bun.file(join(job_dir, "evidence-commit.json")).json()) as Record<string, unknown>
  if (
    pointer.version !== 3 ||
    typeof pointer.generation_id !== "string" ||
    typeof pointer.evidence_directory !== "string" ||
    typeof pointer.files !== "object" ||
    pointer.files === null
  ) {
    throw new Error("Expected a version-3 evidence pointer")
  }
  return pointer as unknown as {
    version: 3
    generation_id: string
    evidence_directory: string
    files: Record<string, { sha256: string; size_bytes: number }>
  }
}

async function createV2EvidenceFixture(): Promise<string> {
  const job_dir = await mkdtemp(join(tmpdir(), "committed-evidence-v2-"))
  temporary_directories.push(job_dir)
  await mkdir(join(job_dir, "visual-reference"), { recursive: true })

  const datasheet = "%PDF-1.7\ntrusted evidence fixture"
  const text_source = { page: 1, method: "pdf_text", confidence: "high" } as const
  const footprint_source = {
    page: 2,
    figure: "Recommended land pattern",
    method: "pdf_visual",
    confidence: "high",
    image: "visual-reference/land-pattern.png",
    render_dpi: 200,
  } as const
  const application_source = {
    page: 3,
    figure: "Typical application",
    method: "pdf_visual",
    confidence: "high",
    image: "visual-reference/typical-application.png",
    render_dpi: 200,
  } as const
  const component_evidence = parseComponentEvidence({
    version: 1,
    status: "resolved",
    part_number: { value: "SOLID-2", sources: [text_source] },
    package: {
      name: { value: "Two-terminal test package", sources: [text_source] },
      pin_count: { value: 2, sources: [text_source] },
    },
    pinout: {
      pins: [
        { number: "1", labels: ["INPUT"], role: "input", sources: [text_source] },
        { number: "2", labels: ["RETURN"], role: "ground", sources: [text_source] },
      ],
    },
    footprint: {
      view: "pcb_top",
      units: "mm",
      drawing_orientation: { value: "pcb_top", sources: [footprint_source] },
      pads: [
        {
          pin: "1",
          kind: "smt",
          x: -0.75,
          y: 0,
          width: 0.55,
          height: 0.8,
          sources: [footprint_source],
        },
        {
          pin: "2",
          kind: "smt",
          x: 0.75,
          y: 0,
          width: 0.55,
          height: 0.8,
          sources: [footprint_source],
        },
      ],
    },
    unresolved_ambiguities: [],
  })
  const application_plan = parseTypicalApplicationPlan(
    {
      version: 4,
      availability: "documented",
      pcb_implementation: "schematic_only",
      title: "Committed reference application",
      description: "The documented application connects a bypass capacitor.",
      source_references: [application_source],
      components: [
        { reference: "U1", kind: "integrated_circuit", value: "SOLID-2" },
        { reference: "C1", kind: "capacitor", value: "100nF" },
      ],
      connections: [
        { net: "INPUT", pins: ["U1.INPUT", "C1.1"] },
        { net: "RETURN", pins: ["U1.RETURN", "C1.2"] },
      ],
    },
    component_evidence.part_number.value,
  )
  const connectivity_review = parseApplicationConnectivityReview(
    {
      version: 1,
      availability: "documented",
      source: application_source,
      components: application_plan.components.map(({ reference, kind, value, manufacturer_part_number }) => ({
        reference,
        kind,
        ...(value === undefined ? {} : { value }),
        ...(manufacturer_part_number === undefined ? {} : { manufacturer_part_number }),
      })),
      connections: application_plan.connections.map(({ pins }) => ({ pins })),
    },
    application_plan,
  )
  const connectivity_verification = compareApplicationGraphs({
    plan: application_plan,
    review: connectivity_review,
    evidence: component_evidence,
  })
  const footprint_review = parseFootprintGeometryReview(
    {
      version: 1,
      source: footprint_source,
      view: "pcb_top",
      units: "mm",
      pads: component_evidence.footprint.pads.map(({ sources: _sources, ...pad }) => pad),
    },
    component_evidence,
  )
  const footprint_verification = compareFootprintGeometry({
    evidence: component_evidence,
    review: footprint_review,
  })
  const image_sha256 = sha256(png_bytes)
  const image_manifest = {
    version: 1,
    renderer: "pdftoppm",
    render_dpi: 200,
    source_pdf_sha256: sha256(datasheet),
    pages: [
      {
        page: 2,
        image: "visual-reference/source-page-2.png",
        sha256: image_sha256,
        size_bytes: png_bytes.byteLength,
      },
      {
        page: 3,
        image: "visual-reference/source-page-3.png",
        sha256: image_sha256,
        size_bytes: png_bytes.byteLength,
      },
    ],
    aliases: {
      land_pattern: {
        page: 2,
        image: "visual-reference/land-pattern.png",
        sha256: image_sha256,
      },
      typical_application: {
        page: 3,
        image: "visual-reference/typical-application.png",
        sha256: image_sha256,
      },
    },
  }

  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), datasheet),
    writeJson(join(job_dir, "component-evidence.json"), component_evidence),
    writeJson(join(job_dir, "footprint-plan.json"), createFootprintPlanFromEvidence(component_evidence)),
    writeJson(
      join(job_dir, "component-schematic-plan.json"),
      createComponentSchematicPlan(component_evidence),
    ),
    writeJson(join(job_dir, "typical-application-plan.json"), application_plan),
    writeJson(join(job_dir, "footprint-geometry-review.json"), footprint_review),
    writeJson(join(job_dir, "footprint-geometry-verification.json"), footprint_verification),
    writeJson(join(job_dir, "application-connectivity-review.json"), connectivity_review),
    writeJson(join(job_dir, "application-connectivity-verification.json"), connectivity_verification),
    writeJson(join(job_dir, "evidence-image-manifest.json"), image_manifest),
    Bun.write(join(job_dir, "visual-reference", "source-page-2.png"), png_bytes),
    Bun.write(join(job_dir, "visual-reference", "source-page-3.png"), png_bytes),
    Bun.write(join(job_dir, "visual-reference", "land-pattern.png"), png_bytes),
    Bun.write(join(job_dir, "visual-reference", "typical-application.png"), png_bytes),
  ])
  return job_dir
}

async function writeLegacyCommit(job_dir: string, relative_paths: string[]): Promise<void> {
  const files: Record<string, { sha256: string; size_bytes: number }> = {}
  for (const relative_path of relative_paths.sort()) {
    const bytes = new Uint8Array(await Bun.file(join(job_dir, relative_path)).arrayBuffer())
    files[relative_path] = { sha256: sha256(bytes), size_bytes: bytes.byteLength }
  }
  await writeJson(join(job_dir, "evidence-commit.json"), {
    version: 1,
    committed_at: new Date().toISOString(),
    files,
  })
}

test("v3 commits publish one immutable semantically validated evidence snapshot", async () => {
  const job_dir = await createV2EvidenceFixture()

  expect(await hasCommittedEvidence(job_dir)).toBe(false)
  const result = await writeEvidenceCommit(job_dir)

  expect(result).toMatchObject({
    status: "committed",
    version: 3,
    commit_path: join(job_dir, "evidence-commit.json"),
  })
  expect(result.file_count).toBe(13)
  expect(result.manifest_sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(result.durability).toBe("directory_synced")
  expect(await hasCommittedEvidence(job_dir)).toBe(true)
  const snapshot = await readCommittedEvidenceSnapshot(job_dir)
  expect(snapshot?.version).toBe(3)
  if (snapshot?.version !== 3) throw new Error("Expected a version-3 evidence snapshot")
  expect(new TextDecoder().decode(snapshot.source_pdf)).toBe("%PDF-1.7\ntrusted evidence fixture")

  new JobStore().createJob({
    job_id: "committed-evidence",
    job_dir,
    file_name: "evidence.pdf",
  })
  const restored = await restoreJobDirectory({
    job_id: "committed-evidence",
    job_dir,
    job_store: new JobStore(),
  })
  expect(restored?.evidence_available).toBe(true)
  expect(restored?.typical_application_title).toBe("Committed reference application")
})

test("v3 snapshots retain immutable manifest-bound PDF bytes", async () => {
  const job_dir = await createV2EvidenceFixture()
  const committed = await writeEvidenceCommit(job_dir)
  const snapshot = await readCommittedEvidenceSnapshot(job_dir)
  if (snapshot?.version !== 3) throw new Error("Expected a version-3 evidence snapshot")

  await Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nmutated after snapshot")

  expect(new TextDecoder().decode(snapshot.source_pdf)).toBe("%PDF-1.7\ntrusted evidence fixture")
  const reread = await readCommittedEvidenceSnapshot(job_dir)
  if (reread?.version !== 3) throw new Error("Expected a version-3 evidence snapshot")
  expect(new TextDecoder().decode(reread.source_pdf)).toBe("%PDF-1.7\ntrusted evidence fixture")

  await Bun.write(join(committed.evidence_dir, "datasheet.pdf"), "%PDF-1.7\ntampered revision")
  await expect(readCommittedEvidenceSnapshot(job_dir)).rejects.toThrow(
    "Committed evidence integrity check failed for datasheet.pdf",
  )
})

test("preparing a replacement keeps the previously committed generation readable", async () => {
  const job_dir = await createV2EvidenceFixture()
  const first = await writeEvidenceCommit(job_dir)
  const prepared = await prepareEvidencePublication({ source_dir: job_dir, job_dir })

  expect((await readV3Pointer(job_dir)).generation_id).toBe(first.generation_id)
  expect((await readCommittedEvidenceSnapshot(job_dir))?.version).toBe(3)

  const second = await commitPreparedEvidencePublication(prepared)
  expect(second.generation_id).not.toBe(first.generation_id)
  expect((await readV3Pointer(job_dir)).generation_id).toBe(second.generation_id)
  expect((await readCommittedEvidenceSnapshot(job_dir))?.version).toBe(3)
})

test("a failed replacement preserves the prior pointer and removes its uncommitted revision", async () => {
  const job_dir = await createV2EvidenceFixture()
  const first = await writeEvidenceCommit(job_dir)
  const prepared = await prepareEvidencePublication({ source_dir: job_dir, job_dir })
  await Bun.write(join(prepared.revision_dir, "component-evidence.json"), '{"tampered":true}\n')

  await expect(commitPreparedEvidencePublication(prepared)).rejects.toThrow(
    "Committed evidence integrity check failed for component-evidence.json",
  )
  expect((await readV3Pointer(job_dir)).generation_id).toBe(first.generation_id)
  expect((await readCommittedEvidenceSnapshot(job_dir))?.version).toBe(3)
  expect(await Bun.file(prepared.revision_dir).exists()).toBe(false)
})

test("cancelling before the pointer commit preserves the prior generation", async () => {
  const job_dir = await createV2EvidenceFixture()
  const first = await writeEvidenceCommit(job_dir)
  const prepared = await prepareEvidencePublication({ source_dir: job_dir, job_dir })
  const controller = new AbortController()
  controller.abort(new Error("cancel replacement"))

  await expect(commitPreparedEvidencePublication(prepared, { signal: controller.signal })).rejects.toThrow(
    "cancel replacement",
  )
  expect((await readV3Pointer(job_dir)).generation_id).toBe(first.generation_id)
  expect((await readCommittedEvidenceSnapshot(job_dir))?.version).toBe(3)
  expect(await Bun.file(prepared.revision_dir).exists()).toBe(false)
})

test("v2 commits require an independent not-present review and agreement", async () => {
  const job_dir = await createV2EvidenceFixture()
  const component_evidence = parseComponentEvidence(
    await Bun.file(join(job_dir, "component-evidence.json")).json(),
  )
  const application_plan = parseTypicalApplicationPlan(
    {
      version: 4,
      availability: "not_present",
      title: "No documented application",
      description: "The independent searches found no application circuit.",
      source_references: [{ page: 1, method: "pdf_text", confidence: "high" }],
      searched_sections: ["application information", "reference design"],
      components: [],
      connections: [],
    },
    component_evidence.part_number.value,
  )
  const connectivity_review = parseApplicationConnectivityReview(
    {
      version: 1,
      availability: "not_present",
      searched_sections: ["application information", "reference design"],
    },
    application_plan,
  )
  const connectivity_verification = compareApplicationGraphs({
    plan: application_plan,
    review: connectivity_review,
    evidence: component_evidence,
  })
  const datasheet_bytes = new Uint8Array(await Bun.file(join(job_dir, "datasheet.pdf")).arrayBuffer())
  const image_sha256 = sha256(png_bytes)
  await Promise.all([
    rm(join(job_dir, "visual-reference", "source-page-3.png")),
    rm(join(job_dir, "visual-reference", "typical-application.png")),
    writeJson(join(job_dir, "typical-application-plan.json"), application_plan),
    writeJson(join(job_dir, "application-connectivity-review.json"), connectivity_review),
    writeJson(join(job_dir, "application-connectivity-verification.json"), connectivity_verification),
    writeJson(join(job_dir, "evidence-image-manifest.json"), {
      version: 1,
      renderer: "pdftoppm",
      render_dpi: 200,
      source_pdf_sha256: sha256(datasheet_bytes),
      pages: [
        {
          page: 2,
          image: "visual-reference/source-page-2.png",
          sha256: image_sha256,
          size_bytes: png_bytes.byteLength,
        },
      ],
      aliases: {
        land_pattern: {
          page: 2,
          image: "visual-reference/land-pattern.png",
          sha256: image_sha256,
        },
      },
    }),
  ])

  const result = await writeEvidenceCommit(job_dir)

  expect(result).toMatchObject({ status: "committed", version: 3, file_count: 11 })
  expect(await hasCommittedEvidence(job_dir)).toBe(true)
})

test("v2 refuses canonical but unresolved component evidence", async () => {
  const job_dir = await createV2EvidenceFixture()
  const evidence_path = join(job_dir, "component-evidence.json")
  const component_evidence = (await Bun.file(evidence_path).json()) as {
    status: string
    unresolved_ambiguities: string[]
  }
  component_evidence.status = "unresolved"
  component_evidence.unresolved_ambiguities = ["Pad geometry is ambiguous."]
  await writeJson(evidence_path, component_evidence)

  await expect(writeEvidenceCommit(job_dir)).rejects.toThrow(
    "Committed component evidence is not publishable: evidence extraction is unresolved",
  )
  expect(await hasCommittedEvidence(job_dir)).toBe(false)
})

test("v1 hash-only evidence commits remain readable for existing jobs", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "committed-evidence-v1-"))
  temporary_directories.push(job_dir)
  await mkdir(join(job_dir, "visual-reference"), { recursive: true })
  const relative_paths = [
    "component-evidence.json",
    "footprint-plan.json",
    "component-schematic-plan.json",
    "typical-application-plan.json",
    "visual-reference/land-pattern.png",
  ]
  await Promise.all([
    Bun.write(join(job_dir, "component-evidence.json"), '{"version":1}\n'),
    Bun.write(join(job_dir, "footprint-plan.json"), '{"version":1}\n'),
    Bun.write(join(job_dir, "component-schematic-plan.json"), '{"version":1}\n'),
    Bun.write(
      join(job_dir, "typical-application-plan.json"),
      '{"version":4,"title":"Legacy reference application"}\n',
    ),
    Bun.write(join(job_dir, "visual-reference", "land-pattern.png"), png_bytes),
  ])

  await writeLegacyCommit(job_dir, relative_paths)

  expect(await hasCommittedEvidence(job_dir)).toBe(true)
  expect((await readCommittedEvidenceSnapshot(job_dir))?.version).toBe(1)

  const optional_path = "application-connectivity-verification.json"
  await Bun.write(join(job_dir, optional_path), '{"later_diagnostic":true}\n')
  expect(await hasCommittedEvidence(job_dir)).toBe(true)

  const marker_path = join(job_dir, "evidence-commit.json")
  const marker = (await Bun.file(marker_path).json()) as {
    files: Record<string, { sha256: string; size_bytes: number }>
  }
  const optional_bytes = new Uint8Array(await Bun.file(join(job_dir, optional_path)).arrayBuffer())
  marker.files[optional_path] = {
    sha256: sha256(optional_bytes),
    size_bytes: optional_bytes.byteLength,
  }
  await writeJson(marker_path, marker)
  expect(await hasCommittedEvidence(job_dir)).toBe(true)
})

test("v2 checks image-manifest hashes against the captured committed bytes", async () => {
  const job_dir = await createV2EvidenceFixture()
  const committed = await writeEvidenceCommit(job_dir)
  const image_manifest_path = join(committed.evidence_dir, "evidence-image-manifest.json")
  const image_manifest = (await Bun.file(image_manifest_path).json()) as {
    pages: Array<{ page: number; sha256: string }>
    aliases: { land_pattern: { sha256: string } }
  }
  const forged_sha256 = "0".repeat(64)
  const land_pattern_page = image_manifest.pages.find(({ page }) => page === 2)
  if (!land_pattern_page) throw new Error("fixture image manifest is missing page 2")
  land_pattern_page.sha256 = forged_sha256
  image_manifest.aliases.land_pattern.sha256 = forged_sha256
  await writeJson(image_manifest_path, image_manifest)

  const marker_path = join(job_dir, "evidence-commit.json")
  const marker = (await Bun.file(marker_path).json()) as {
    files: Record<string, { sha256: string; size_bytes: number }>
  }
  const manifest_bytes = new Uint8Array(await Bun.file(image_manifest_path).arrayBuffer())
  marker.files["evidence-image-manifest.json"] = {
    sha256: sha256(manifest_bytes),
    size_bytes: manifest_bytes.byteLength,
  }
  await writeJson(marker_path, marker)

  expect(await hasCommittedEvidence(job_dir)).toBe(false)
  await expect(readCommittedEvidenceSnapshot(job_dir)).rejects.toThrow(
    "Server-rendered evidence page changed after rendering",
  )
})

test("v2 rejects a semantically forged agreement even when its hash is recommitted", async () => {
  const job_dir = await createV2EvidenceFixture()
  const committed = await writeEvidenceCommit(job_dir)
  const verification_path = join(committed.evidence_dir, "application-connectivity-verification.json")
  const verification = (await Bun.file(verification_path).json()) as Record<string, unknown>
  verification.graph_sha256 = "0".repeat(64)
  await writeJson(verification_path, verification)

  const marker_path = join(job_dir, "evidence-commit.json")
  const marker = (await Bun.file(marker_path).json()) as {
    files: Record<string, { sha256: string; size_bytes: number }>
  }
  const forged_bytes = new Uint8Array(await Bun.file(verification_path).arrayBuffer())
  marker.files["application-connectivity-verification.json"] = {
    sha256: sha256(forged_bytes),
    size_bytes: forged_bytes.byteLength,
  }
  await writeJson(marker_path, marker)

  expect(await hasCommittedEvidence(job_dir)).toBe(false)
  await expect(readCommittedEvidenceSnapshot(job_dir)).rejects.toThrow(
    "application-connectivity-verification.json does not match",
  )
})

test("v2 rejects noncanonical independent reviews", async () => {
  const job_dir = await createV2EvidenceFixture()
  const review_path = join(job_dir, "application-connectivity-review.json")
  const review = (await Bun.file(review_path).json()) as Record<string, unknown>
  review.agent_note = "This field is not part of the review contract."
  await writeJson(review_path, review)

  await expect(writeEvidenceCommit(job_dir)).rejects.toThrow(
    "documented connectivity review contains unsupported fields: agent_note",
  )
  expect(await hasCommittedEvidence(job_dir)).toBe(false)
})

test("v2 binds every evidence image citation to its declared PDF page", async () => {
  const job_dir = await createV2EvidenceFixture()
  const evidence_path = join(job_dir, "component-evidence.json")
  const raw_evidence = (await Bun.file(evidence_path).json()) as {
    footprint: { pads: Array<{ sources: Array<{ page: number }> }> }
  }
  const first_pad_source = raw_evidence.footprint.pads[0]?.sources[0]
  if (!first_pad_source) throw new Error("fixture is missing its first pad source")
  first_pad_source.page = 3
  const component_evidence = parseComponentEvidence(raw_evidence)
  await Promise.all([
    writeJson(evidence_path, component_evidence),
    writeJson(join(job_dir, "footprint-plan.json"), createFootprintPlanFromEvidence(component_evidence)),
  ])

  await expect(writeEvidenceCommit(job_dir)).rejects.toThrow(
    "Footprint evidence binds the trusted land-pattern image to multiple PDF pages",
  )
  expect(await hasCommittedEvidence(job_dir)).toBe(false)
})

test("a late-aborted writer cleans its temporary marker before the publication boundary", async () => {
  const job_dir = await createV2EvidenceFixture()
  const expected_file_count = 13
  let cancellation_checks = 0
  const signal = {
    throwIfAborted() {
      cancellation_checks += 1
      if (cancellation_checks === expected_file_count + 2) {
        throw new Error("stop at evidence commit boundary")
      }
    },
  } as AbortSignal

  await expect(writeEvidenceCommit(job_dir, { signal })).rejects.toThrow("stop at evidence commit boundary")
  expect(cancellation_checks).toBe(expected_file_count + 2)
  expect(await hasCommittedEvidence(job_dir)).toBe(false)
  expect((await readdir(job_dir)).filter((name) => name.includes("evidence-commit"))).toEqual([])
})

test("evidence traversal rejects excessive empty-directory depth", async () => {
  const job_dir = await createV2EvidenceFixture()
  const deep_path = join(
    job_dir,
    "visual-reference",
    ...Array.from({ length: 16 }, (_, index) => `empty-${index}`),
  )
  await mkdir(deep_path, { recursive: true })

  await expect(writeEvidenceCommit(job_dir)).rejects.toThrow("16-level depth limit")
  expect(await hasCommittedEvidence(job_dir)).toBe(false)
})
