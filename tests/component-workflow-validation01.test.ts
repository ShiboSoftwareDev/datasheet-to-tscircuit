import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { validateApplication, validateComponent } from "@/server/component-workflow/component-validation"
import type { ProcessRunner } from "@/server/infrastructure/process"
import { JobStore } from "@/server/job-store"
import { publishCommittedEvidenceFixture } from "./fixtures/committed-evidence"

const visual_source = {
  page: 12,
  figure: "Land pattern",
  method: "pdf_visual",
  confidence: "high",
  image: "visual-reference/land-pattern.png",
  render_dpi: 200,
}

const application_source = {
  page: 8,
  figure: "Typical application",
  method: "pdf_visual",
  confidence: "high",
  image: "visual-reference/typical-application.png",
  render_dpi: 200,
}

function componentEvidence() {
  return {
    version: 1,
    status: "resolved",
    part_number: { value: "GENERIC-2", sources: [visual_source] },
    package: {
      name: { value: "Two terminal package", sources: [visual_source] },
      pin_count: { value: 2, sources: [visual_source] },
    },
    pinout: {
      pins: [
        { number: "1", labels: ["INPUT"], role: "input", sources: [visual_source] },
        { number: "2", labels: ["RETURN"], role: "ground", sources: [visual_source] },
      ],
    },
    footprint: {
      view: "pcb_top",
      units: "mm",
      drawing_orientation: { value: "pcb_top", sources: [visual_source] },
      pads: [
        {
          pin: "1",
          kind: "smt",
          x: -0.75,
          y: 0,
          width: 0.55,
          height: 0.8,
          sources: [visual_source],
        },
        {
          pin: "2",
          kind: "smt",
          x: 0.75,
          y: 0,
          width: 0.55,
          height: 0.8,
          sources: [visual_source],
        },
      ],
    },
    unresolved_ambiguities: [],
  }
}

function documentedApplicationPlan() {
  return {
    version: 4,
    availability: "documented",
    pcb_implementation: "schematic_only",
    title: "Input bypass",
    description: "Documented input bypass circuit.",
    source_references: [application_source],
    components: [
      { reference: "U1", kind: "integrated_circuit", value: "GENERIC-2" },
      { reference: "C1", kind: "capacitor", value: "100nF" },
    ],
    connections: [
      { net: "INPUT", pins: ["U1.INPUT", "C1.pin1"] },
      { net: "RETURN", pins: ["U1.RETURN", "C1.pin2"] },
    ],
  }
}

function emptyCircuitRunner(on_build: (source: string) => void): ProcessRunner {
  return {
    async run(request) {
      if (request.command[1] === "build") {
        const source = request.command[2] ?? "index.circuit.tsx"
        on_build(source)
        const output_stem = basename(source).replace(/\.circuit\.tsx$/, "")
        const output_dir = join(request.cwd, "dist", output_stem)
        await mkdir(output_dir, { recursive: true })
        await Bun.write(join(output_dir, "circuit.json"), "[]\n")
      }
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    },
  }
}

test("component and application validators reject empty Circuit JSON", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "empty-circuit-validation-"))
  const job_store = new JobStore()
  job_store.createJob({
    job_id: "empty-circuit",
    job_dir,
    file_name: "generic.pdf",
  })
  const builds: string[] = []
  const process_runner = emptyCircuitRunner((source) => builds.push(source))
  const signal = new AbortController().signal

  try {
    await publishCommittedEvidenceFixture({
      job_dir,
      component_evidence: componentEvidence(),
      application_plan: documentedApplicationPlan(),
    })
    await Promise.all([
      Bun.write(join(job_dir, "index.circuit.tsx"), 'export default () => <chip name="U1" />\n'),
      Bun.write(
        join(job_dir, "typical-application.circuit.tsx"),
        'import Component from "./component.circuit"\nexport default () => <board><Component name="U1" /><capacitor name="C1" capacitance="100nF" /></board>\n',
      ),
      Bun.write(join(job_dir, "component.circuit.tsx"), 'export default () => <chip name="U1" />\n'),
      Bun.write(join(job_dir, "component.circuit.json"), "[]\n"),
    ])

    const component = await validateComponent({
      job_id: "empty-circuit",
      job_dir,
      job_store,
      tsci_bin: "fake-tsci",
      process_runner,
      signal,
      on_output() {},
    })
    expect(component.passed).toBe(false)
    expect(component.errors).toContain("shape: tsci produced empty Circuit JSON")
    expect(component.circuit_json).toEqual([])
    expect(job_store.getJob("empty-circuit")?.validation).toMatchObject({
      component_build: "failed",
      component_drc: "failed",
      footprint: "failed",
      pinout: "failed",
      component_schematic: "failed",
      component_visual: "failed",
    })

    const repeated_component = await validateComponent({
      job_id: "empty-circuit",
      job_dir,
      job_store,
      tsci_bin: "fake-tsci",
      process_runner,
      signal,
      on_output() {},
    })
    expect(repeated_component).toEqual(component)
    expect(repeated_component).not.toHaveProperty("generated_at")

    const application = await validateApplication({
      job_id: "empty-circuit",
      job_dir,
      job_store,
      tsci_bin: "fake-tsci",
      process_runner,
      signal,
      on_output() {},
    })
    expect(application.passed).toBe(false)
    expect(application.errors).toContain("shape: tsci produced empty Circuit JSON")
    expect(application.circuit_json).toEqual([])
    expect(job_store.getJob("empty-circuit")?.validation).toMatchObject({
      application_build: "failed",
      application_connectivity: "failed",
      application_schematic: "failed",
      application_visual: "failed",
    })
    expect(builds).toEqual(["index.circuit.tsx", "index.circuit.tsx", "typical-application.circuit.tsx"])
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})
