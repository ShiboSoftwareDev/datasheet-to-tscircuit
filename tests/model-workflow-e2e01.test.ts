import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import type { AgentClient } from "@/server/infrastructure/agent"
import { atomicWriteJsonSync } from "@/server/infrastructure/persistence/atomic-write"
import type { ProcessRunner, ProcessRunRequest, ProcessRunResult } from "@/server/infrastructure/process"
import { restorePersistedJobs } from "@/server/job-restorer"
import { JobStore } from "@/server/job-store"
import { ModelRunStore } from "@/server/model-run-store"
import { runModel } from "@/server/model-workflow"
import { publishCommittedEvidenceFixture } from "./fixtures/committed-evidence"

const ngspice_path = Bun.which("ngspice")
const testWithNgspice = ngspice_path ? test : test.skip
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

const model_source = `.SUBCKT TEST_GAIN IN OUT GND
E_GAIN OUT GND IN GND 2
.ENDS TEST_GAIN
`

const characterization = {
  version: 1,
  family: "other",
  strategy: "behavioral",
  requirements: [
    {
      requirement_id: "dc_gain",
      title: "DC voltage gain",
      behavior: "The output is twice the input voltage relative to ground.",
      analysis: "dc_sweep",
      support: { status: "modeled" },
      conditions: { load_resistance_ohms: 10_000 },
      expected: { unit: "V", min: 0, max: 2 },
      reference_curve: {
        x_quantity: "input voltage",
        x_unit: "V",
        y_quantity: "output voltage",
        y_unit: "V",
        tolerance: 1e-6,
        points: [
          { x: 0, y: 0 },
          { x: 0.25, y: 0.5 },
          { x: 0.5, y: 1 },
          { x: 0.75, y: 1.5 },
          { x: 1, y: 2 },
        ],
      },
      sources: [
        {
          page: 1,
          locator: "Electrical characteristics, voltage gain",
          statement: "The nominal voltage gain is two.",
        },
      ],
    },
  ],
  assumptions: ["The test fixture uses an ideal ground reference."],
  limitations: ["This fixture exercises only the documented DC gain."],
}

const validation_plan = {
  version: 1,
  model: { entry_name: "TEST_GAIN", pins: ["IN", "OUT", "GND"] },
  cases: [
    {
      id: "dc_gain",
      title: "DC gain sweep",
      requirement_ids: ["dc_gain"],
      nets: [],
      fixtures: [
        {
          type: "voltage_source",
          id: "vin",
          positive: "dut.IN",
          negative: "gnd",
          dc_volts: 0,
        },
        {
          type: "resistor",
          id: "load",
          positive: "dut.OUT",
          negative: "gnd",
          resistance_ohms: 10_000,
        },
        {
          type: "voltage_source",
          id: "ground_ref",
          positive: "dut.GND",
          negative: "gnd",
          dc_volts: 0,
        },
      ],
      analysis: { type: "dc_sweep", source_id: "vin", start: 0, stop: 1, step: 0.25 },
      observations: [
        {
          type: "voltage",
          id: "output_voltage",
          requirement_id: "dc_gain",
          positive: "dut.OUT",
          negative: "gnd",
          unit: "V",
          scale: "linear",
          // Production runs 91/92 emitted agent-authored evidence even though
          // evidence is server-owned. The workflow must replace this shape,
          // including its extra fields, instead of spending retries asking the
          // agent to reproduce a private canonical object exactly.
          evidence: {
            page: 999,
            image: "evidence/source-page-999.png",
            locator: "agent-authored production locator",
            statement: "agent-authored production statement",
          },
          reference: { type: "target", target: 999, tolerance: 999 },
        },
      ],
    },
  ],
}

function deterministicAgent(calls: string[]): AgentClient {
  return {
    async run(input) {
      calls.push(input.phase_label)
      const application_plan = JSON.parse(
        await Bun.file(join(input.workspace, "typical-application-plan.json")).text(),
      ) as { availability?: string }
      expect(application_plan.availability).toBe("not_present")
      if (input.phase_label === "Model characterization") {
        await Bun.write(
          join(input.workspace, "model-characterization.json"),
          `${JSON.stringify(characterization, null, 2)}\n`,
        )
      } else if (input.phase_label === "Validation-plan design") {
        await Bun.write(
          join(input.workspace, "validation-plan.json"),
          `${JSON.stringify(validation_plan, null, 2)}\n`,
        )
      } else if (input.phase_label === "SPICE model generation") {
        await Promise.all([
          Bun.write(join(input.workspace, "model.lib"), model_source),
          Bun.write(
            join(input.workspace, "model-card.md"),
            "# TEST-GAIN\n\nA deterministic two-times DC gain model.\n",
          ),
        ])
      } else {
        throw new Error(`Unexpected agent phase: ${input.phase_label}`)
      }
      await input.on_output("stdout", `fixture completed ${input.phase_label}\n`)
      return { attempts: 1, duration_ms: 1, output_tail: "" }
    },
  }
}

class FakeWrapperBuildRunner implements ProcessRunner {
  readonly calls: ProcessRunRequest[] = []

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request)
    if (request.command[0] === "pdftoppm") {
      const output_prefix = request.command.at(-1)
      if (!output_prefix) throw new Error("Fixture pdftoppm command omitted its output prefix")
      await Bun.write(`${output_prefix}.png`, png_bytes)
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    if (
      request.command[1] === "build" &&
      request.command[2]?.endsWith(".circuit.tsx") &&
      request.command[2] !== "component-with-model.circuit.tsx"
    ) {
      const output_stem = request.command[2].replace(/\.circuit\.tsx$/, "")
      const output_directory = join(request.cwd, "dist", output_stem)
      await mkdir(output_directory, { recursive: true })
      await writeFile(
        join(output_directory, "circuit.json"),
        `${JSON.stringify([{ type: "source_component", source_component_id: `preview_${output_stem}` }])}\n`,
        "utf8",
      )
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    if (request.command[1] !== "build" || request.command[2] !== "component-with-model.circuit.tsx") {
      throw new Error(`Unexpected process command: ${request.command.join(" ")}`)
    }
    const [wrapper_source, component_circuit, model_interface] = await Promise.all([
      readFile(join(request.cwd, "component-with-model.circuit.tsx"), "utf8"),
      readFile(join(request.cwd, "component.circuit.json"), "utf8").then(JSON.parse),
      readFile(join(request.cwd, "model-interface.json"), "utf8").then(JSON.parse),
    ])
    const encoded_model_source = /^const modelSource = (.+)$/m.exec(wrapper_source)?.[1]
    if (!encoded_model_source) throw new Error("Generated wrapper did not contain modelSource")
    const source = JSON.parse(encoded_model_source) as string
    const output_directory = join(request.cwd, "dist", "component-with-model")
    await mkdir(output_directory, { recursive: true })
    await writeFile(
      join(output_directory, "circuit.json"),
      `${JSON.stringify(
        [
          ...component_circuit,
          {
            type: "simulation_spice_subcircuit",
            simulation_spice_subcircuit_id: "simulation_spice_subcircuit_test_gain",
            source_component_id: "source_component_test_gain",
            spice_pin_to_source_port_map: Object.fromEntries(
              model_interface.pins.map(
                ({ spice_node, source_port_id }: { spice_node: string; source_port_id: string }) => [
                  spice_node,
                  source_port_id,
                ],
              ),
            ),
            subcircuit_source: source,
          },
        ],
        null,
        2,
      )}\n`,
      "utf8",
    )
    return { exit_code: 0, duration_ms: 1, output_tail: "" }
  }
}

testWithNgspice(
  "MODEL_PIPELINE keeps committed publication authoritative when later checkpoints fail",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "datasheet-model-pipeline-e2e-"))
    temporary_directories.push(root)
    const job_dir = join(root, "job_model_e2e")
    const model_dir = join(job_dir, "spice")
    await mkdir(job_dir, { recursive: true })

    const evidence_source = { page: 1, method: "pdf_text", confidence: "high" }
    const land_pattern_source = {
      page: 2,
      figure: "Recommended land pattern",
      method: "pdf_visual",
      confidence: "high",
      image: "visual-reference/land-pattern.png",
      render_dpi: 200,
    }
    const component_evidence = {
      version: 1,
      status: "resolved",
      part_number: { value: "TEST-GAIN", sources: [evidence_source] },
      package: {
        name: { value: "SOT-23", sources: [evidence_source] },
        pin_count: { value: 3, sources: [evidence_source] },
      },
      pinout: {
        pins: [
          { number: "1", labels: ["IN"], role: "input", sources: [evidence_source] },
          { number: "2", labels: ["OUT"], role: "output", sources: [evidence_source] },
          { number: "3", labels: ["GND"], role: "ground", sources: [evidence_source] },
        ],
      },
      footprint: {
        view: "pcb_top",
        units: "mm",
        drawing_orientation: { value: "pcb_top", sources: [land_pattern_source] },
        pads: [
          {
            pin: "1",
            kind: "smt",
            x: -1,
            y: -1,
            width: 0.6,
            height: 1,
            sources: [land_pattern_source],
          },
          {
            pin: "2",
            kind: "smt",
            x: 1,
            y: -1,
            width: 0.6,
            height: 1,
            sources: [land_pattern_source],
          },
          {
            pin: "3",
            kind: "smt",
            x: 0,
            y: 1,
            width: 0.6,
            height: 1,
            sources: [land_pattern_source],
          },
        ],
      },
      unresolved_ambiguities: [],
    }
    const component_source = `export default function TestGain(props: Record<string, unknown>) {
  return <chip name="U1" {...props} />
}
`
    const component_circuit = [
      {
        type: "source_component",
        source_component_id: "source_component_test_gain",
        name: "U1",
      },
      ...[
        ["1", "IN"],
        ["2", "OUT"],
        ["3", "GND"],
      ].map(([pin, label]) => ({
        type: "source_port",
        source_port_id: `source_port_${pin}`,
        source_component_id: "source_component_test_gain",
        pin_number: pin,
        name: label,
        port_hints: [`pin${pin}`, label],
      })),
    ] as AnyCircuitElement[]
    const application_plan = {
      version: 4,
      availability: "not_present",
      title: "No documented application",
      description: "The fixture datasheet does not contain an application circuit.",
      source_references: [evidence_source],
      searched_sections: ["application information", "reference design"],
      components: [],
      connections: [],
    }
    await Promise.all([
      Bun.write(join(job_dir, "component.circuit.tsx"), component_source),
      Bun.write(join(job_dir, "index.circuit.tsx"), component_source),
      Bun.write(join(job_dir, "component.circuit.json"), `${JSON.stringify(component_circuit, null, 2)}\n`),
    ])
    await publishCommittedEvidenceFixture({
      job_dir,
      datasheet: "%PDF-1.4\n% deterministic test fixture\n",
      component_evidence,
      application_plan,
    })

    let rejected_post_commit_job_checkpoints = 0
    const job_store = new JobStore({
      checkpoint_writer(path, value) {
        if (existsSync(join(job_dir, "published-model.json"))) {
          rejected_post_commit_job_checkpoints += 1
          throw new Error("fixture post-publication job checkpoint failure")
        }
        atomicWriteJsonSync(path, value)
      },
    })
    let rejected_post_commit_checkpoints = 0
    const model_run_store = new ModelRunStore({
      checkpoint_writer(path, value) {
        if (existsSync(join(job_dir, "published-model.json"))) {
          rejected_post_commit_checkpoints += 1
          throw new Error("fixture post-publication checkpoint failure")
        }
        atomicWriteJsonSync(path, value)
      },
    })
    job_store.createJob({ job_id: "job_model_e2e", job_dir, file_name: "test-gain.pdf" })
    job_store.updateJob("job_model_e2e", {
      display_status: "complete",
      is_complete: true,
      component_ready: true,
      component_code: component_source,
      circuit_json: component_circuit,
    })
    model_run_store.createModelRun({
      model_run_id: "model_e2e",
      job_id: "job_model_e2e",
      model_dir,
      effort_multiplier: 1,
    })
    const agent_calls: string[] = []
    const process_runner = new FakeWrapperBuildRunner()

    await runModel(
      { model_run_id: "model_e2e" },
      {
        job_store,
        model_run_store,
        agent_bin: "unused-agent",
        tsci_bin: "fixture-tsci",
        ngspice_bin: ngspice_path!,
        agent_client: deterministicAgent(agent_calls),
        process_runner,
      },
    )

    const run = model_run_store.getModelRun("model_e2e")
    expect(rejected_post_commit_job_checkpoints).toBeGreaterThan(0)
    expect(rejected_post_commit_checkpoints).toBeGreaterThan(0)
    expect(run).toMatchObject({
      status: "complete",
      is_complete: true,
      has_errors: false,
      validation: { all_passed: true, all_critical_passed: true, passing_count: 1 },
      circuit_preview: { build_status: "ready", circuit_json: [{ type: "source_component" }] },
      pipeline: { pipeline_id: "datasheet_model", status: "completed" },
    })
    expect(Object.values(run!.pipeline!.stage_results).map(({ status }) => status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ])
    expect(agent_calls).toEqual([
      "Model characterization",
      "Validation-plan design",
      "SPICE model generation",
    ])
    expect(process_runner.calls).toHaveLength(3)

    const candidates = await readdir(join(model_dir, "candidates"))
    expect(candidates).toHaveLength(1)
    const candidate_dir = join(model_dir, "candidates", candidates[0]!)
    const immutable_result = JSON.parse(
      await readFile(join(candidate_dir, "validation", "validation-results.json"), "utf8"),
    )
    expect(immutable_result).toMatchObject({
      version: 1,
      passed: true,
      cases: [{ case_id: "dc_gain", status: "passed" }],
    })
    expect(await readFile(join(candidate_dir, "model.lib"), "utf8")).toBe(model_source)
    expect(await Bun.file(join(candidate_dir, "model-manifest.json")).exists()).toBe(true)
    expect(await Bun.file(join(candidate_dir, "validation", "dc_gain", "result.raw")).exists()).toBe(true)

    const canonical_plan = JSON.parse(
      await readFile(join(model_dir, "validation-plan.json"), "utf8"),
    ) as typeof validation_plan
    expect(canonical_plan.cases[0]?.observations[0]).toMatchObject({
      evidence: {
        page: 1,
        image: "evidence/source-page-1.png",
        metadata: { figure: "Electrical characteristics, voltage gain" },
      },
      reference: {
        type: "curve",
        tolerance: 1e-6,
        points: characterization.requirements[0]?.reference_curve?.points,
      },
    })

    const published_index = await readFile(join(job_dir, "index.circuit.tsx"), "utf8")
    expect(published_index).toContain("<spicemodel")
    expect(published_index).toContain("spicePinMapping")
    expect(await readFile(join(job_dir, "component.circuit.tsx"), "utf8")).toBe(component_source)
    expect(await readFile(join(job_dir, "model.lib"), "utf8")).toBe(model_source)
    expect(job_store.getJob("job_model_e2e")?.component_code).toBe(published_index)
    expect(
      job_store
        .getJob("job_model_e2e")
        ?.circuit_json?.filter(({ type }) => type === "simulation_spice_subcircuit"),
    ).toHaveLength(1)
    expect(await Bun.file(join(model_dir, "component-with-model.circuit.json")).exists()).toBe(true)

    const restored_jobs = new JobStore()
    const restored_models = new ModelRunStore()
    expect(
      await restorePersistedJobs({
        jobs_root: root,
        job_store: restored_jobs,
        model_run_store: restored_models,
      }),
    ).toEqual({ jobs_restored: 1, model_runs_restored: 1 })
    expect(restored_models.getModelRunForJob("job_model_e2e")?.status).toBe("complete")
    expect(
      restored_jobs
        .getJob("job_model_e2e")
        ?.circuit_json?.filter(({ type }) => type === "simulation_spice_subcircuit"),
    ).toHaveLength(1)
  },
)
