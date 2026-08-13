import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseComponentEvidence } from "@/server/component-evidence"
import {
  applyFootprintGeometryObservation,
  compareFootprintGeometry,
  componentEvidenceWithVerifiedFootprintGeometry,
  observeFootprintGeometry,
  parseFootprintGeometryReview,
  verifyFootprintGeometry,
} from "@/server/component-workflow/footprint-geometry-verification"
import type { AgentClient } from "@/server/infrastructure/agent"

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

const text_source = { page: 1, method: "pdf_text", confidence: "high" } as const
const footprint_source = {
  page: 7,
  figure: "Recommended land pattern",
  method: "pdf_visual",
  confidence: "high",
  image: "visual-reference/land-pattern.png",
  render_dpi: 200,
} as const

function evidence() {
  return parseComponentEvidence({
    version: 1,
    status: "resolved",
    part_number: { value: "SOLID-3", sources: [text_source] },
    package: {
      name: { value: "Special-pad package", sources: [text_source] },
      pin_count: { value: 3, sources: [text_source] },
    },
    pinout: {
      pins: [
        { number: "1", labels: ["IN"], role: "input", sources: [text_source] },
        { number: "2", labels: ["GND"], role: "ground", sources: [text_source] },
        { number: "3", labels: ["SW"], role: "output", sources: [text_source] },
      ],
    },
    footprint: {
      view: "pcb_top",
      units: "mm",
      drawing_orientation: { value: "pcb_top", sources: [footprint_source] },
      pads: [
        { pin: "1", kind: "smt", x: -1, y: 0, width: 0.9, height: 0.6, sources: [footprint_source] },
        { pin: "2", kind: "smt", x: 0, y: 0, width: 0.9, height: 0.6, sources: [footprint_source] },
        { pin: "3", kind: "smt", x: 1, y: 0, width: 1.3, height: 0.8, sources: [footprint_source] },
      ],
    },
    unresolved_ambiguities: [],
  })
}

function reviewPads() {
  return evidence().footprint.pads.map(({ sources: _sources, ...pad }) => pad)
}

function review(pads = reviewPads()) {
  const component_evidence = evidence()
  return parseFootprintGeometryReview(
    {
      version: 1,
      source: footprint_source,
      view: "pcb_top",
      units: "mm",
      pads,
    },
    component_evidence,
  )
}

test("independent geometry agreement is deterministic and pin-format tolerant", () => {
  const component_evidence = evidence()
  const independent = review(
    reviewPads()
      .reverse()
      .map((pad) => ({ ...pad, pin: pad.pin === null ? null : `pin${pad.pin}` })),
  )

  const agreement = compareFootprintGeometry({ evidence: component_evidence, review: independent })

  expect(agreement).toMatchObject({
    version: 1,
    status: "verified",
    schema_id: "footprint-geometry-review/v1",
    tolerance_mm: 0.01,
  })
  expect(agreement.geometry_sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(agreement.extractor_pads).toEqual(agreement.verifier_pads)
})

test("a well-formed independent review catches a copied special-pad width", () => {
  const copied_width = reviewPads().map((pad) => (pad.pin === "3" ? { ...pad, width: 0.9 } : pad))
  const independent = review(copied_width)

  expect(() => compareFootprintGeometry({ evidence: evidence(), review: independent })).toThrow(
    "pin 3 width differs: evidence 1.3 mm, comparison 0.9 mm",
  )
})

test("an exposed-pad label outside the electrical pin interface is treated as mechanical copper", () => {
  const component_evidence = evidence()
  component_evidence.footprint.pads.push({
    pin: null,
    kind: "smt",
    x: 0,
    y: 1,
    width: 1.2,
    height: 1.4,
    sources: [footprint_source],
  })
  const independent = parseFootprintGeometryReview(
    {
      version: 1,
      source: footprint_source,
      view: "pcb_top",
      units: "mm",
      pads: [...reviewPads(), { pin: "thermal_pad", kind: "smt", x: 0, y: 1, width: 1.2, height: 1.4 }],
    },
    component_evidence,
  )

  const agreement = compareFootprintGeometry({ evidence: component_evidence, review: independent })

  expect(agreement.extractor_pads).toEqual(agreement.verifier_pads)
  expect(agreement.verifier_pads).toContainEqual({
    pin: null,
    kind: "smt",
    x: 0,
    y: 1,
    width: 1.2,
    height: 1.4,
  })
})

test("verified physical geometry replaces extractor geometry without changing its electrical contract", () => {
  const component_evidence = evidence()
  const independent = review(
    reviewPads().map((pad) => (pad.pin === "3" ? { ...pad, x: 1.2, width: 1.4 } : { ...pad })),
  )

  const reconciled = componentEvidenceWithVerifiedFootprintGeometry({
    evidence: component_evidence,
    observation: {
      review: independent,
      verifier_attempts: 1,
      verifier_agent_duration_ms: 10,
    },
  })

  expect(reconciled.pinout).toEqual(component_evidence.pinout)
  expect(reconciled.footprint.pads.find(({ pin }) => pin === "3")).toEqual({
    pin: "3",
    kind: "smt",
    x: 1.2,
    y: 0,
    width: 1.4,
    height: 0.8,
    sources: [footprint_source],
  })
  expect(() => compareFootprintGeometry({ evidence: reconciled, review: independent })).not.toThrow()
})

test("geometry review schema rejects unknown fields and untrusted image provenance", () => {
  expect(() =>
    parseFootprintGeometryReview(
      {
        version: 1,
        source: footprint_source,
        view: "pcb_top",
        units: "mm",
        pads: reviewPads(),
        extractor_pads: reviewPads(),
      },
      evidence(),
    ),
  ).toThrow("footprint geometry review contains unsupported fields: extractor_pads")

  expect(() =>
    parseFootprintGeometryReview(
      {
        version: 1,
        source: { ...footprint_source, image: "agent-authored.png" },
        view: "pcb_top",
        units: "mm",
        pads: reviewPads(),
      },
      evidence(),
    ),
  ).toThrow("must cite visual-reference/land-pattern.png")

  expect(() =>
    parseFootprintGeometryReview(
      {
        version: 1,
        source: { ...footprint_source, confidence: "low" },
        view: "pcb_top",
        units: "mm",
        pads: reviewPads(),
      },
      evidence(),
    ),
  ).toThrow("footprint geometry review source.confidence is invalid")
})

test("geometry review allows distinct copper pads on one pin but rejects contained duplicates", () => {
  const duplicate_pin = reviewPads()
  duplicate_pin[1] = { ...duplicate_pin[1]!, pin: "pin1" }

  expect(() => review(duplicate_pin)).not.toThrow()

  expect(() =>
    review([...reviewPads(), { pin: null, kind: "smt", x: 1, y: 0, width: 1.5, height: 1 }]),
  ).toThrow(/represents one physical copper area twice/)

  expect(() =>
    review([
      ...reviewPads(),
      {
        pin: null,
        kind: "plated_hole",
        x: 1,
        y: 0,
        width: 0.4,
        height: 0.4,
        hole_width: 0.2,
        hole_height: 0.2,
      },
    ]),
  ).toThrow(/represents one physical copper area twice/)
})

test("verifier workspace exposes no extractor pin names or geometry", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "footprint-verification-outer-"))
  temporary_directories.push(workspace)
  await mkdir(join(workspace, "visual-reference"), { recursive: true })
  await Promise.all([
    Bun.write(join(workspace, "datasheet.pdf"), "%PDF-1.7\nfixture\n"),
    Bun.write(join(workspace, "visual-reference", "land-pattern.png"), png_bytes),
  ])
  let saw_isolated_contract = false
  const agent_client: AgentClient = {
    async run(input) {
      expect(input.phase_label).toBe("Independent footprint geometry verification")
      const names = (await readdir(input.workspace)).sort()
      expect(names).toContain("datasheet.pdf")
      expect(names).not.toContain("verification-request.json")
      expect(names).not.toContain("component-evidence.json")
      expect(names).not.toContain("footprint-plan.json")
      expect(input.prompt).not.toContain("pin_naming_hints")
      expect(input.prompt).not.toContain("verification-request.json")
      saw_isolated_contract = true
      await Bun.write(
        join(input.workspace, "footprint-geometry-review.json"),
        `${JSON.stringify(
          {
            version: 1,
            source: footprint_source,
            view: "pcb_top",
            units: "mm",
            pads: reviewPads(),
          },
          null,
          2,
        )}\n`,
      )
      return { attempts: 1, duration_ms: 5, output_tail: "" }
    },
  }

  const agreement = await verifyFootprintGeometry({
    workspace,
    evidence: evidence(),
    outer_attempt: 1,
    debug_dir: join(workspace, "debug"),
    signal: new AbortController().signal,
    use_openai: false,
    agent_client,
    image_extension: "unused-extension.ts",
    on_output: () => undefined,
  })

  expect(saw_isolated_contract).toBe(true)
  expect(agreement).toMatchObject({ status: "verified", verifier_attempts: 1 })
  expect(await Bun.file(join(workspace, "footprint-geometry-review.json")).exists()).toBe(true)
})

test("a cached footprint observation atomically replaces an untrusted outer copy", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "footprint-verification-cache-"))
  temporary_directories.push(workspace)
  await mkdir(join(workspace, "visual-reference"), { recursive: true })
  await Promise.all([
    Bun.write(join(workspace, "datasheet.pdf"), "%PDF-1.7\nfixture\n"),
    Bun.write(join(workspace, "visual-reference", "land-pattern.png"), png_bytes),
  ])
  let verifier_calls = 0
  const agent_client: AgentClient = {
    async run(input) {
      verifier_calls += 1
      await Bun.write(
        join(input.workspace, "footprint-geometry-review.json"),
        `${JSON.stringify(
          {
            version: 1,
            source: footprint_source,
            view: "pcb_top",
            units: "mm",
            pads: reviewPads(),
          },
          null,
          2,
        )}\n`,
      )
      return { attempts: 1, duration_ms: 5, output_tail: "" }
    },
  }
  const observation = await observeFootprintGeometry({
    workspace,
    evidence: evidence(),
    outer_attempt: 1,
    debug_dir: join(workspace, "debug"),
    signal: new AbortController().signal,
    use_openai: false,
    agent_client,
    image_extension: "unused-extension.ts",
    on_output: () => undefined,
  })

  const protected_path = join(workspace, "protected.json")
  const review_path = join(workspace, "footprint-geometry-review.json")
  await Bun.write(protected_path, '{"protected":true}\n')
  await rm(review_path)
  await symlink(protected_path, review_path)

  const agreement = applyFootprintGeometryObservation({
    workspace,
    evidence: evidence(),
    observation,
  })

  expect(verifier_calls).toBe(1)
  expect(agreement.status).toBe("verified")
  expect(await Bun.file(protected_path).text()).toBe('{"protected":true}\n')
  expect(await Bun.file(review_path).json()).toEqual(observation.review)
})
