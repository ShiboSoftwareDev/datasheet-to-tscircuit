import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { restoreModelDirectory } from "@/server/job-restorer/restore-model-directory"
import { ModelRunStore } from "@/server/model-run-store"
import { createModelManifest, type ModelContract } from "@/server/modeling"
import {
  hashValidationInputs,
  type ValidationPlan,
  type ValidationRunResult,
} from "@/server/spice-validation"
import type { ModelManifest } from "@/shared/job-types"

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function contract(): ModelContract {
  return {
    version: 1,
    interface: {
      version: 1,
      part_number: "RESTORE-GAIN",
      entry_name: "RESTORE_GAIN",
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
    },
    characterization: {
      version: 1,
      family: "other",
      strategy: "behavioral",
      requirements: [
        {
          requirement_id: "output_bias",
          title: "Output bias",
          behavior: "The output rests at ground with a grounded input.",
          analysis: "operating_point",
          support: { status: "modeled" },
          conditions: { input_voltage: 0 },
          expected: { unit: "V", target: 0, tolerance: 0.001 },
          sources: [
            {
              page: 3,
              locator: "Electrical characteristics",
              statement: "Output bias is specified at zero input.",
            },
          ],
        },
      ],
      assumptions: [],
      limitations: [],
    },
  }
}

function validationPlan(): ValidationPlan {
  return {
    version: 1,
    model: { entry_name: "RESTORE_GAIN", pins: ["IN", "OUT"] },
    cases: [
      {
        id: "output_bias",
        title: "Output bias at zero input",
        requirement_ids: ["output_bias"],
        nets: [],
        fixtures: [
          {
            type: "voltage_source",
            id: "input",
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
        ],
        analysis: { type: "operating_point" },
        observations: [
          {
            type: "voltage",
            id: "output_voltage",
            requirement_id: "output_bias",
            positive: "dut.OUT",
            negative: "gnd",
            unit: "V",
            scale: "linear",
            reference: { type: "target", target: 0, tolerance: 0.001 },
          },
        ],
      },
    ],
  }
}

async function writeCompletedFixture(): Promise<{
  model_dir: string
  model_source: string
  model_contract: ModelContract
  manifest: ModelManifest
  plan: ValidationPlan
  result: ValidationRunResult
}> {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-restore-integrity-"))
  temporary_directories.push(model_dir)
  const model_contract = contract()
  const plan = validationPlan()
  const model_source = `.SUBCKT RESTORE_GAIN IN OUT
R_GAIN IN OUT 1k
.ENDS RESTORE_GAIN
`
  const manifest = createModelManifest({
    model_interface: model_contract.interface,
    model_source,
    simulator: "ngspice",
  })
  const result: ValidationRunResult = {
    version: 1,
    passed: true,
    hashes: hashValidationInputs({ plan, model_source, manifest }),
    cases: [
      {
        case_id: "output_bias",
        status: "passed",
        analysis: "operating_point",
        series: [
          {
            observation_id: "output_voltage",
            type: "voltage",
            unit: "V",
            scale: "linear",
            points: [{ x: 0, y: 0 }],
            passed: true,
            metrics: { sample_count: 1, max_absolute_error: 0 },
            errors: [],
          },
        ],
        errors: [],
        elapsed_ms: 1,
        netlist_sha256: "1".repeat(64),
        raw_sha256: "2".repeat(64),
      },
    ],
    errors: [],
  }
  const now = new Date().toISOString()
  await Promise.all([
    Bun.write(
      join(model_dir, "model-run.json"),
      JSON.stringify({
        model_run_id: "model_restore_integrity",
        job_id: "job_restore_integrity",
        created_at: now,
        updated_at: now,
        completed_at: now,
        status: "complete",
        is_complete: true,
        has_errors: false,
        effort_multiplier: 1,
        elapsed_time_ms: 500,
        iteration: 1,
        logs: [],
        progress_history: [],
        validation: {
          benchmark_count: 1,
          passing_count: 1,
          critical_count: 1,
          critical_passing_count: 1,
          all_critical_passed: true,
          all_passed: true,
          benchmarks: [],
        },
        circuit_preview: {
          source_file: "benchmarks/output-bias.circuit.tsx",
          code: "export default () => null",
          build_status: "ready",
          updated_at: now,
        },
        reference_preview: {
          benchmark_id: "output_bias",
          title: "Output bias",
          source_file: "evidence/output-bias.csv",
          x_scale: "linear",
          y_scale: "linear",
          reference_points: [{ x: 0, y: 0 }],
          updated_at: now,
        },
        preview_options: [
          {
            benchmark_id: "output_bias",
            title: "Output bias",
            circuit_file: "benchmarks/output-bias.circuit.tsx",
          },
        ],
      }),
    ),
    Bun.write(join(model_dir, "model.lib"), model_source),
    Bun.write(join(model_dir, "model-card.md"), "# Restored model\n"),
    Bun.write(join(model_dir, "model-manifest.json"), JSON.stringify(manifest)),
    Bun.write(join(model_dir, "model-contract.json"), JSON.stringify(model_contract)),
    Bun.write(join(model_dir, "validation-plan.json"), JSON.stringify(plan)),
    Bun.write(join(model_dir, "validation-results.json"), JSON.stringify(result)),
  ])
  return { model_dir, model_source, model_contract, manifest, plan, result }
}

async function restore(model_dir: string) {
  return restoreModelDirectory({
    job_id: "job_restore_integrity",
    model_dir,
    model_run_store: new ModelRunStore(),
  })
}

describe("completed model restore integrity", () => {
  test("restores a passing result only when all current input hashes match", async () => {
    const fixture = await writeCompletedFixture()

    const restored = await restore(fixture.model_dir)

    expect(restored?.status).toBe("complete")
    expect(restored?.has_errors).toBe(false)
    expect(restored?.error_message).toBeUndefined()
    expect(restored?.manifest?.revision).toBe(
      createModelManifest({
        model_interface: fixture.model_contract.interface,
        model_source: fixture.model_source,
        simulator: "ngspice",
      }).revision,
    )
  })

  test("fails restore when a valid current plan no longer matches the validated plan hash", async () => {
    const fixture = await writeCompletedFixture()
    const changed_plan = structuredClone(fixture.plan)
    changed_plan.cases[0]!.title = "Changed after validation"
    await Bun.write(join(fixture.model_dir, "validation-plan.json"), JSON.stringify(changed_plan))

    const restored = await restore(fixture.model_dir)

    expect(restored?.status).toBe("failed")
    expect(restored?.has_errors).toBe(true)
    expect(restored?.error_message).toContain("validation input hash mismatch for validation-plan.json")
    expect(restored?.model_source).toBeUndefined()
    expect(restored?.manifest).toBeUndefined()
    expect(restored?.validation).toBeUndefined()
    expect(restored?.model_card).toBeUndefined()
    expect(restored?.circuit_preview).toBeUndefined()
    expect(restored?.reference_preview).toBeUndefined()
    expect(restored?.preview_options).toEqual([])
  })

  test("rejects a contract-invalid plan even when its stored hash was updated", async () => {
    const fixture = await writeCompletedFixture()
    const changed_plan = structuredClone(fixture.plan)
    const observation = changed_plan.cases[0]!.observations[0]!
    if (observation.type !== "voltage") throw new Error("test fixture must use a voltage observation")
    observation.reference = { type: "target", target: 1, tolerance: 0.001 }
    const rehashed_result = {
      ...fixture.result,
      hashes: hashValidationInputs({
        plan: changed_plan,
        model_source: fixture.model_source,
        manifest: fixture.manifest,
      }),
    }
    await Promise.all([
      Bun.write(join(fixture.model_dir, "validation-plan.json"), JSON.stringify(changed_plan)),
      Bun.write(join(fixture.model_dir, "validation-results.json"), JSON.stringify(rehashed_result)),
    ])

    const restored = await restore(fixture.model_dir)

    expect(restored?.status).toBe("failed")
    expect(restored?.error_message).toContain("requirement_reference_mismatch")
  })

  test("fails restore when current model and manifest differ from the validated inputs", async () => {
    const fixture = await writeCompletedFixture()
    const changed_source = `* edited after validation\n${fixture.model_source}`
    const changed_manifest = createModelManifest({
      model_interface: fixture.model_contract.interface,
      model_source: changed_source,
      simulator: "ngspice",
    })
    await Promise.all([
      Bun.write(join(fixture.model_dir, "model.lib"), changed_source),
      Bun.write(join(fixture.model_dir, "model-manifest.json"), JSON.stringify(changed_manifest)),
    ])

    const restored = await restore(fixture.model_dir)

    expect(restored?.status).toBe("failed")
    expect(restored?.error_message).toContain("validation input hash mismatch for model.lib")
    expect(restored?.error_message).toContain("model-manifest.json")
  })

  test("does not trust a passing flag without complete per-case validation artifacts", async () => {
    const fixture = await writeCompletedFixture()
    await Bun.write(
      join(fixture.model_dir, "validation-results.json"),
      JSON.stringify({ ...fixture.result, cases: [] }),
    )

    const restored = await restore(fixture.model_dir)

    expect(restored?.status).toBe("failed")
    expect(restored?.error_message).toContain(
      "validation-results.json.cases has 0 cases; the current plan has 1",
    )
  })
})
