import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentClient } from "@/server/infrastructure/agent"
import type { ProcessRunner } from "@/server/infrastructure/process"
import { JobStore } from "@/server/job-store"
import { ModelRunStore } from "@/server/model-run-store"
import { runSimulationsStage } from "@/server/model-workflow/stages/validate-model"
import {
  createModelManifest,
  type GeneratedModel,
  type ModelContract,
  ModelStrategyRegistry,
} from "@/server/modeling"
import { loadStoredModelPreview } from "@/server/modeling/ui-projection-storage"
import { type NgspiceExecutor, parseAgentValidationPlan } from "@/server/spice-validation"

const model_interface = {
  version: 1 as const,
  part_number: "VALIDATION-FAILURE",
  entry_name: "VALIDATION_FAILURE",
  pins: [
    {
      physical_pin: "1",
      component_pin: "pin1",
      source_port_id: "source_port_in",
      spice_node: "IN",
      labels: ["IN"],
      role: "input",
    },
    {
      physical_pin: "2",
      component_pin: "pin2",
      source_port_id: "source_port_out",
      spice_node: "OUT",
      labels: ["OUT"],
      role: "output",
    },
  ],
}

const pulse = {
  low: 0,
  high: 1,
  delay: 0.001,
  rise: 0.0002,
  fall: 0.0002,
  width: 0.001,
  period: 0.004,
}

const reference_points = [
  { x: 0, y: 0 },
  { x: 0.0005, y: 0 },
  { x: 0.001, y: 0 },
  { x: 0.0012, y: 1 },
  { x: 0.0017, y: 1 },
  { x: 0.0022, y: 1 },
  { x: 0.0024, y: 0 },
  { x: 0.003, y: 0 },
]

const contract: ModelContract = {
  version: 1,
  interface: model_interface,
  characterization: {
    version: 1,
    family: "other",
    strategy: "behavioral",
    requirements: [
      {
        requirement_id: "step_response",
        title: "Step response",
        behavior: "OUT follows the printed voltage response after the input step.",
        analysis: "transient",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "V", min: 0, max: 1 },
        reference_curve: {
          channel_id: "output_voltage",
          channel_label: "OUT",
          channel_role: "response",
          measurement: { type: "voltage", positive: "dut.OUT", negative: "gnd" },
          x_quantity: "time",
          x_unit: "s",
          y_quantity: "voltage",
          y_unit: "V",
          tolerance: 0.05,
          points: reference_points,
          crop: {
            page: 1,
            render_dpi: 200,
            x_px: 20,
            y_px: 30,
            width_px: 96,
            height_px: 64,
          },
          image: "evidence/step-response.png",
          electrical_binding: {
            response: { type: "voltage", positive: "dut.OUT", negative: "gnd" },
            stimulus: {
              type: "voltage_step",
              positive: "dut.IN",
              negative: "gnd",
              pulse,
            },
          },
        },
        sources: [
          {
            page: 1,
            locator: "Figure 1, step response",
            statement: "The output voltage is plotted against elapsed time.",
            image: "evidence/step-response.png",
          },
        ],
      },
    ],
    assumptions: [],
    limitations: [],
  },
}

const model_source = `.SUBCKT VALIDATION_FAILURE IN OUT
E_RESPONSE OUT 0 IN 0 1
.ENDS VALIDATION_FAILURE
`

const generated: GeneratedModel = {
  source: model_source,
  card: "# Validation failure fixture\n",
  manifest: createModelManifest({ model_interface, model_source, simulator: "ngspice" }),
}

const plan = parseAgentValidationPlan(
  {
    version: 1,
    model: { entry_name: "VALIDATION_FAILURE", pins: ["IN", "OUT"] },
    cases: [
      {
        id: "step-response",
        title: "Step response",
        requirement_ids: ["step_response"],
        nets: [],
        fixtures: [
          {
            id: "input_step",
            type: "voltage_source",
            positive: "dut.IN",
            negative: "gnd",
            dc_volts: pulse.low,
            pulse,
          },
          {
            id: "output_load",
            type: "resistor",
            positive: "dut.OUT",
            negative: "gnd",
            resistance_ohms: 10_000,
          },
        ],
        analysis: { type: "transient", step: 0.0001, stop: 0.003 },
        observations: [
          {
            id: "output_voltage",
            requirement_id: "step_response",
            type: "voltage",
            positive: "dut.OUT",
            negative: "gnd",
            unit: "V",
            scale: "linear",
          },
        ],
      },
    ],
  },
  {
    model_interface,
    model_requirements: contract.characterization.requirements,
    model_family: contract.characterization.family,
  },
)

test("validate_model retains failed viewer UI but reports direct validation infrastructure first", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-validation-stage-failure-"))
  try {
    const job_dir = join(root, "job")
    const model_dir = join(job_dir, "spice")
    const candidate_dir = join(model_dir, "candidates", "candidate-1")
    const evidence_dir = join(model_dir, "attempts", "attempt-1", "evidence")
    const contract_path = join(model_dir, "attempts", "attempt-1", "model-contract.json")
    const plan_path = join(model_dir, "attempts", "attempt-1", "validation-plan.json")
    const model_path = join(candidate_dir, "model.lib")
    const model_card_path = join(candidate_dir, "model-card.md")
    const manifest_path = join(candidate_dir, "model-manifest.json")
    await Promise.all([mkdir(candidate_dir, { recursive: true }), mkdir(evidence_dir, { recursive: true })])
    await Promise.all([
      Bun.write(contract_path, `${JSON.stringify(contract, null, 2)}\n`),
      Bun.write(plan_path, `${JSON.stringify(plan, null, 2)}\n`),
      Bun.write(model_path, generated.source),
      Bun.write(model_card_path, generated.card),
      Bun.write(manifest_path, `${JSON.stringify(generated.manifest, null, 2)}\n`),
      Bun.write(
        join(evidence_dir, "step-response.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XGzOAAAAAElFTkSuQmCC",
          "base64",
        ),
      ),
    ])

    const model_run_store = new ModelRunStore()
    model_run_store.createModelRun({
      model_run_id: "model_validation_failure",
      job_id: "job_validation_failure",
      model_dir,
      effort_multiplier: 1,
    })
    const job_store = new JobStore()
    const unused_agent: AgentClient = {
      async run() {
        throw new Error("validate_model must not call the model agent")
      },
    }
    let ngspice_calls = 0
    const failing_ngspice: NgspiceExecutor = async () => {
      ngspice_calls += 1
      throw new Error("fixture ngspice executable is unavailable")
    }
    let viewer_build_calls = 0
    const failing_viewer: ProcessRunner = {
      async run(request) {
        viewer_build_calls += 1
        expect(request.command.slice(0, 2)).toEqual(["fixture-tsci", "build"])
        throw new Error("fixture tsci viewer build failed")
      },
    }
    const invocation_id = "invocation-validation-failure-01"

    let caught: unknown
    try {
      await runSimulationsStage.execute({
        run_id: "model_validation_failure",
        pipeline_id: "spice_generation",
        stage_id: "run_simulations",
        debug_dir: join(model_dir, "debug"),
        context: {
          model_run_id: "model_validation_failure",
          job_id: "job_validation_failure",
          job_dir,
          model_dir,
          use_openai: false,
          max_repair_attempts: 1,
          invocation_id,
        },
        services: {
          job_store,
          model_run_store,
          agent_client: unused_agent,
          process_runner: failing_viewer,
          strategy_registry: new ModelStrategyRegistry(),
          tsci_bin: "fixture-tsci",
          ngspice_bin: "fixture-ngspice",
          ngspice_executor: failing_ngspice,
        },
        dependency_outputs: {
          create_simulation_tsx: {
            source_dir: "",
            source_manifest_path: "",
            model_path,
            model_card_path,
            manifest_path,
            contract_path,
            plan_path,
            evidence_dir,
            revision: generated.manifest.revision,
            case_count: plan.cases.length,
          },
        },
        signal: new AbortController().signal,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      diagnostic: {
        code: "model_validation_infrastructure_failed",
        stage_id: "run_simulations",
        operation: "classify_validation_failure",
      },
    })
    expect((caught as { diagnostic?: { message?: string } }).diagnostic?.message).toContain(
      "ngspice_spawn_failed",
    )
    expect((caught as { diagnostic?: { message?: string } }).diagnostic?.message).not.toContain(
      "fixture tsci viewer build failed",
    )
    expect(ngspice_calls).toBe(2)
    expect(viewer_build_calls).toBe(1)

    const model_run = model_run_store.getModelRun("model_validation_failure")
    expect(model_run?.validation).toMatchObject({
      artifact_state: "candidate",
      model_revision: generated.manifest.revision,
      all_passed: false,
    })
    expect(model_run?.circuit_preview).toMatchObject({
      build_status: "failed",
      analysis_type: "transient",
      analog_simulation_status: "failed",
    })
    expect(model_run?.circuit_preview?.code).toContain("<analogsimulation")
    expect(model_run?.reference_preview).toMatchObject({
      benchmark_id: "step-response",
      source_file: "evidence/step-response.png",
      reference_kind: "curve",
      result_status: "failed",
      result_origin: "tscircuit_viewer",
      matches_reference: false,
    })
    expect(model_run?.reference_preview?.reference_points).toEqual(reference_points)

    const preview_generation = model_run?.validation?.preview_generation
    const expected_preview_generation = `${invocation_id}-${generated.manifest.revision}`
    expect(preview_generation).toBe(expected_preview_generation)
    const stored_preview = await loadStoredModelPreview({
      job_id: "job_validation_failure",
      model_dir,
      case_id: "step-response",
      current_preview_generation: expected_preview_generation,
      current_model_revision: generated.manifest.revision,
    })
    expect(stored_preview?.artifact_identity).toEqual({
      preview_generation: expected_preview_generation,
      model_revision: generated.manifest.revision,
    })
    expect(stored_preview?.circuit_preview?.build_status).toBe("failed")
    expect(stored_preview?.circuit_preview?.code).toContain("<analogsimulation")
    expect(stored_preview?.reference_preview?.reference_points).toEqual(reference_points)
    const stored_code = stored_preview?.circuit_preview?.code
    if (!stored_code) throw new Error("Stored failed candidate preview omitted its TSX source")
    expect(
      await readFile(
        join(
          model_dir,
          "current-previews",
          expected_preview_generation,
          "cases",
          "step-response.circuit.tsx",
        ),
        "utf8",
      ),
    ).toBe(stored_code)
    expect(
      await Bun.file(
        join(model_dir, "current-previews", expected_preview_generation, "evidence", "step-response.png"),
      ).exists(),
    ).toBe(true)
    const diagnostic_path = join(
      model_dir,
      "current-previews",
      expected_preview_generation,
      "candidate-diagnostics.json",
    )
    const diagnostic_bundle = JSON.parse(await readFile(diagnostic_path, "utf8"))
    expect(diagnostic_bundle).toMatchObject({
      version: 1,
      status: "failed",
      cases: [
        {
          case_id: "step-response",
          analysis: "transient",
          circuit_build_status: "failed",
          artifacts: {
            preview: "cases/step-response.preview.json",
            tsx: "cases/step-response.circuit.tsx",
          },
        },
      ],
    })
    const build_diagnostic = diagnostic_bundle.cases[0].diagnostics.find(
      ({ source }: { source: string }) => source === "tscircuit_build",
    )
    expect(build_diagnostic?.message).toContain("fixture tsci viewer build failed")
    expect(build_diagnostic?.message).not.toContain(root)
    expect(
      (caught as { diagnostic?: { artifact_refs?: Array<{ path?: string }> } }).diagnostic?.artifact_refs,
    ).toContainEqual({
      path: join(candidate_dir, "validation", "candidate-diagnostics.json"),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
