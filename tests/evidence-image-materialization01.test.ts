import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseComponentEvidence } from "@/server/component-evidence"
import {
  assertEvidenceImageManifest,
  materializeEvidenceImages,
  parseEvidenceImageManifest,
} from "@/server/component-workflow/evidence-image-materialization"
import { parseTypicalApplicationPlan } from "@/server/component-workflow/application-plan"
import type { ProcessRunner, ProcessRunRequest, ProcessRunResult } from "@/server/infrastructure/process"

const trusted_png = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
)

class PdfRendererFixture implements ProcessRunner {
  readonly pages: number[] = []

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    expect(request.command[0]).toBe("pdftoppm")
    const page = Number(request.command[2])
    const output_prefix = request.command.at(-1)
    if (!output_prefix) throw new Error("Fixture renderer received no output prefix")
    this.pages.push(page)
    await Bun.write(`${output_prefix}.png`, trusted_png)
    return { exit_code: 0, duration_ms: 1, output_tail: "" }
  }
}

test("every citation is bound to a deterministic page rendered from the datasheet", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "evidence-image-materialization-"))
  try {
    await mkdir(join(workspace, "visual-reference"), { recursive: true })
    await Promise.all([
      Bun.write(join(workspace, "datasheet.pdf"), "%PDF trusted fixture"),
      Bun.write(join(workspace, "visual-reference", "land-pattern.png"), "agent-controlled bytes"),
      Bun.write(join(workspace, "visual-reference", "typical-application.png"), "agent-controlled bytes"),
    ])
    const text_source = { page: 1, method: "pdf_text", confidence: "high" } as const
    const footprint_source = {
      page: 2,
      method: "pdf_visual",
      confidence: "high",
      image: "visual-reference/land-pattern.png",
      render_dpi: 200,
    } as const
    const package_top_source = {
      page: 4,
      method: "pdf_visual",
      confidence: "high",
      image: "visual-reference/package-top.png",
      render_dpi: 200,
    } as const
    const component_evidence = parseComponentEvidence({
      version: 1,
      status: "resolved",
      part_number: { value: "TEST-2", sources: [text_source] },
      package: {
        name: { value: "TEST", sources: [text_source] },
        pin_count: { value: 2, sources: [text_source] },
      },
      pinout: {
        pins: [
          { number: "1", labels: ["IN"], role: "input", sources: [text_source] },
          { number: "2", labels: ["GND"], role: "ground", sources: [text_source] },
        ],
      },
      footprint: {
        view: "pcb_top",
        units: "mm",
        drawing_orientation: {
          value: "pcb_top",
          sources: [package_top_source, footprint_source],
        },
        pads: [
          { pin: "1", kind: "smt", x: -1, y: 0, width: 1, height: 1, sources: [footprint_source] },
          { pin: "2", kind: "smt", x: 1, y: 0, width: 1, height: 1, sources: [footprint_source] },
        ],
      },
      unresolved_ambiguities: [],
    })
    const application_plan = parseTypicalApplicationPlan(
      {
        version: 4,
        availability: "documented",
        pcb_implementation: "schematic_only",
        title: "Input bypass",
        description: "Documented circuit",
        source_references: [
          {
            page: 3,
            method: "pdf_visual",
            confidence: "high",
            image: "visual-reference/typical-application.png",
            render_dpi: 200,
          },
        ],
        components: [
          { reference: "U1", kind: "integrated_circuit", value: "TEST-2" },
          { reference: "C1", kind: "capacitor", value: "100nF" },
        ],
        connections: [
          { net: "IN", pins: ["U1.IN", "C1.1"] },
          { net: "GND", pins: ["U1.GND", "C1.2"] },
        ],
      },
      "TEST-2",
    )
    const renderer = new PdfRendererFixture()
    const result = await materializeEvidenceImages({
      workspace,
      component_evidence,
      application_plan,
      process_runner: renderer,
      signal: new AbortController().signal,
    })

    expect(renderer.pages).toEqual([1, 2, 3, 4])
    expect(await readFile(join(workspace, "visual-reference", "land-pattern.png"))).toEqual(
      Buffer.from(trusted_png),
    )
    expect(await readFile(join(workspace, "visual-reference", "typical-application.png"))).toEqual(
      Buffer.from(trusted_png),
    )
    expect(result.component_evidence.footprint.drawing_orientation.sources[0]?.image).toBe(
      "visual-reference/source-page-4.png",
    )
    expect(result.component_evidence.footprint.drawing_orientation.sources[1]?.image).toBe(
      "visual-reference/land-pattern.png",
    )
    expect(result.component_evidence.pinout.pins[0]?.sources[0]?.image).toBe(
      "visual-reference/source-page-1.png",
    )
    expect(result.manifest.aliases.land_pattern.page).toBe(2)
    expect(result.application_plan.source_references[0]?.image).toBe(
      "visual-reference/typical-application.png",
    )
    expect(result.manifest).toMatchObject({
      version: 1,
      renderer: "pdftoppm",
      render_dpi: 200,
      source_pdf_sha256: createHash("sha256").update("%PDF trusted fixture").digest("hex"),
    })
    const parsed_manifest = parseEvidenceImageManifest(result.manifest)
    await assertEvidenceImageManifest({
      root: workspace,
      manifest: parsed_manifest,
      application_available: true,
    })
    await Bun.write(join(workspace, "visual-reference", "land-pattern.png"), "tampered")
    await expect(
      assertEvidenceImageManifest({
        root: workspace,
        manifest: parsed_manifest,
        application_available: true,
      }),
    ).rejects.toThrow("does not match its rendered PDF page")
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
