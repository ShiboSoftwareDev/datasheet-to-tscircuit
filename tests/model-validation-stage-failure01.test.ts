import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentClient } from "@/server/infrastructure/agent"
import { ProcessError, type ProcessRunner } from "@/server/infrastructure/process"
import { JobStore } from "@/server/job-store"
import { ModelRunStore } from "@/server/model-run-store"
import { persistCandidateValidationUi } from "@/server/model-workflow/stage-helpers/candidate-ui"
import { repairModelStage } from "@/server/model-workflow/stages/repair-model"
import { runSimulationsStage } from "@/server/model-workflow/stages/validate-model"
import {
  createModelManifest,
  type GeneratedModel,
  type ModelContract,
  ModelStrategyRegistry,
} from "@/server/modeling"
import {
  type NgspiceExecutor,
  parseAgentValidationPlan,
  type ValidationRunResult,
} from "@/server/spice-validation"

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

test("Run Simulations uses only tsci and retains execution failure without comparison state", async () => {
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
        code: "model_viewer_simulation_failed",
        stage_id: "run_simulations",
        operation: "execute_tscircuit_simulations",
      },
    })
    expect((caught as { diagnostic?: { message?: string } }).diagnostic?.message).toContain("step-response")
    expect(ngspice_calls).toBe(0)
    expect(viewer_build_calls).toBe(1)

    const model_run = model_run_store.getModelRun("model_validation_failure")
    expect(model_run?.validation).toBeUndefined()
    expect(model_run?.circuit_preview).toBeUndefined()
    expect(model_run?.reference_preview).toBeUndefined()

    const receipt_path = join(candidate_dir, "simulation", "tscircuit-simulation-results.json")
    const receipt = JSON.parse(await readFile(receipt_path, "utf8"))
    expect(receipt).toMatchObject({
      version: 1,
      cases: [
        {
          case_id: "step-response",
          status: "failed",
          failure_kind: "build",
        },
      ],
    })
    expect(receipt.cases[0].error).toContain("fixture tsci viewer build failed")
    expect(receipt.cases[0].error).not.toContain(root)
    expect(
      (caught as { diagnostic?: { artifact_refs?: Array<{ path?: string }> } }).diagnostic?.artifact_refs,
    ).toContainEqual({
      path: receipt_path,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Repair completes with the best candidate when its quality budget expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-repair-quality-budget-"))
  try {
    const job_dir = join(root, "job")
    const model_dir = join(job_dir, "spice")
    const candidate_dir = join(model_dir, "candidates", "candidate-1")
    const source_dir = join(candidate_dir, "simulation-tsx")
    const validation_dir = join(candidate_dir, "validation")
    const evidence_dir = join(model_dir, "attempts", "attempt-1", "evidence")
    const contract_path = join(model_dir, "attempts", "attempt-1", "model-contract.json")
    const plan_path = join(model_dir, "attempts", "attempt-1", "validation-plan.json")
    const model_path = join(candidate_dir, "model.lib")
    const model_card_path = join(candidate_dir, "model-card.md")
    const manifest_path = join(candidate_dir, "model-manifest.json")
    const result_path = join(validation_dir, "validation-results.json")
    const quality_error = {
      kind: "comparison" as const,
      code: "curve_tolerance_exceeded",
      message: "The modeled response remains outside its curve tolerance.",
    }
    const result: ValidationRunResult = {
      version: 1,
      passed: false,
      hashes: {
        plan_sha256: "1".repeat(64),
        model_sha256: "2".repeat(64),
        manifest_sha256: "3".repeat(64),
      },
      cases: [
        {
          case_id: "step-response",
          status: "failed",
          analysis: "transient",
          series: [
            {
              observation_id: "output_voltage",
              type: "voltage",
              unit: "V",
              scale: "linear",
              points: [
                { x: 0, y: 0 },
                { x: 0.001, y: 0.5 },
              ],
              passed: false,
              metrics: { sample_count: 2, normalized_rmse: 0.5, normalized_max_error: 0.6 },
              errors: [quality_error],
            },
          ],
          errors: [quality_error],
          elapsed_ms: 1,
          netlist_sha256: "4".repeat(64),
          raw_sha256: "5".repeat(64),
        },
      ],
      errors: [quality_error],
    }

    await Promise.all([
      mkdir(source_dir, { recursive: true }),
      mkdir(validation_dir, { recursive: true }),
      mkdir(evidence_dir, { recursive: true }),
    ])
    await Promise.all([
      Bun.write(join(model_dir, "AGENTS.md"), "# Repair fixture\n"),
      Bun.write(join(model_dir, "model-interface.json"), `${JSON.stringify(model_interface)}\n`),
      Bun.write(contract_path, `${JSON.stringify(contract)}\n`),
      Bun.write(plan_path, `${JSON.stringify(plan)}\n`),
      Bun.write(model_path, generated.source),
      Bun.write(model_card_path, generated.card),
      Bun.write(manifest_path, `${JSON.stringify(generated.manifest)}\n`),
      Bun.write(result_path, `${JSON.stringify(result)}\n`),
    ])
    await persistCandidateValidationUi({
      plan,
      result,
      generated,
      contract,
      immutable_artifact_dir: validation_dir,
      preview_generation: `repair-quality-${generated.manifest.revision}`,
    })

    const model_run_store = new ModelRunStore()
    model_run_store.createModelRun({
      model_run_id: "repair_quality_budget",
      job_id: "repair_quality_job",
      model_dir,
      effort_multiplier: 1,
    })
    const stale_source = generated.source.replace("1k", "2k")
    model_run_store.projectDevelopmentModel("repair_quality_budget", {
      model_source: stale_source,
      model_card: "Stale development candidate\n",
      manifest: createModelManifest({
        model_interface,
        model_source: stale_source,
        simulator: "ngspice",
      }),
    })
    let agent_calls = 0
    const outcome = await repairModelStage.execute({
      run_id: "repair_quality_budget",
      pipeline_id: "spice_generation",
      stage_id: "repair_spice_model",
      debug_dir: join(model_dir, "debug"),
      context: {
        model_run_id: "repair_quality_budget",
        job_id: "repair_quality_job",
        job_dir,
        model_dir,
        use_openai: false,
        repair_budget_ms: 100,
        invocation_id: "repair-quality-invocation",
      },
      services: {
        job_store: new JobStore(),
        model_run_store,
        agent_client: {
          async run(input) {
            agent_calls += 1
            return new Promise<never>((_resolve, reject) => {
              const rejectForAbort = () =>
                reject(
                  new ProcessError({
                    code: "process_cancelled",
                    command_label: "repair fixture",
                    message: "repair fixture was cancelled",
                  }),
                )
              if (input.signal.aborted) rejectForAbort()
              else input.signal.addEventListener("abort", rejectForAbort, { once: true })
            })
          },
        },
        process_runner: {
          async run() {
            throw new Error("tscircuit must not run before a repair candidate exists")
          },
        },
        strategy_registry: new ModelStrategyRegistry(),
        tsci_bin: "fixture-tsci",
      },
      dependency_outputs: {
        compare_simulation_outputs: {
          result_path,
          model_path,
          model_card_path,
          manifest_path,
          contract_path,
          plan_path,
          evidence_dir,
          passed: false,
          case_count: 1,
          failing_case_ids: ["step-response"],
          revision: generated.manifest.revision,
        },
      },
      signal: new AbortController().signal,
    })

    expect(agent_calls).toBe(1)
    expect(outcome).toMatchObject({
      status: "completed",
      output: {
        passed: false,
        revision: generated.manifest.revision,
        model_path,
        result_path,
      },
      diagnostics: [{ code: "model_quality_target_not_met", severity: "warning" }],
    })
    expect(model_run_store.getModelRun("repair_quality_budget")).toMatchObject({
      repair_started_at: undefined,
      development_model: { model_source: generated.source },
      validation: { model_revision: generated.manifest.revision },
      preview_options: [{ benchmark_id: "step-response" }],
    })
    expect(JSON.parse(await readFile(join(model_dir, "current-preview.json"), "utf8"))).toMatchObject({
      revision: generated.manifest.revision,
      preview_generation: `repair-quality-${generated.manifest.revision}`,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
