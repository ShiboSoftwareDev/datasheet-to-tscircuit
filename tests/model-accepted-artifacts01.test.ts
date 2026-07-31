import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRunStore } from "@/server/model-run-store"
import { persistCandidateValidationUi } from "@/server/model-workflow/stage-helpers"
import { createModelManifest, type GeneratedModel, type ModelContract } from "@/server/modeling"
import {
  hashValidationInputs,
  type ValidationPlan,
  type ValidationRunResult,
} from "@/server/spice-validation"

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const contract: ModelContract = {
  version: 1,
  interface: {
    version: 1,
    part_number: "ACCEPTED",
    entry_name: "ACCEPTED",
    pins: [
      {
        physical_pin: "1",
        component_pin: "pin1",
        source_port_id: "source_port_1",
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
        requirement_id: "output",
        title: "Output",
        behavior: "Output voltage",
        analysis: "operating_point",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "V", target: 1, tolerance: 0.01 },
        sources: [{ page: 1, locator: "table", statement: "Output is one volt" }],
      },
    ],
    assumptions: [],
    limitations: [],
  },
}

const plan: ValidationPlan = {
  version: 1,
  model: { entry_name: "ACCEPTED", pins: ["OUT"] },
  cases: [
    {
      id: "output",
      requirement_ids: ["output"],
      nets: [],
      fixtures: [
        {
          type: "resistor",
          id: "load",
          positive: "dut.OUT",
          negative: "gnd",
          resistance_ohms: 1_000,
        },
      ],
      analysis: { type: "operating_point" },
      observations: [
        {
          type: "voltage",
          id: "output_voltage",
          requirement_id: "output",
          positive: "dut.OUT",
          negative: "gnd",
          unit: "V",
          scale: "linear",
          reference: { type: "target", target: 1, tolerance: 0.01 },
        },
      ],
    },
  ],
}

function resultFor(generated: GeneratedModel, passed: boolean): ValidationRunResult {
  return {
    version: 1,
    passed,
    hashes: hashValidationInputs({ plan, model_source: generated.source, manifest: generated.manifest }),
    cases: [
      {
        case_id: "output",
        status: passed ? "passed" : "failed",
        analysis: "operating_point",
        series: [
          {
            observation_id: "output_voltage",
            type: "voltage",
            unit: "V",
            scale: "linear",
            points: [{ x: 0, y: passed ? 1 : 0 }],
            passed,
            metrics: { sample_count: 1 },
            errors: passed
              ? []
              : [{ kind: "comparison", code: "target_tolerance_exceeded", message: "failed" }],
          },
        ],
        errors: passed ? [] : [{ kind: "comparison", code: "target_tolerance_exceeded", message: "failed" }],
        elapsed_ms: 1,
        netlist_sha256: "1".repeat(64),
        raw_sha256: "2".repeat(64),
      },
    ],
    errors: passed ? [] : [{ kind: "comparison", code: "target_tolerance_exceeded", message: "failed" }],
  }
}

test("even passing validation stays candidate-private until integrated publication", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "accepted-model-artifacts-"))
  temporary_directories.push(model_dir)
  const immutable_artifact_dir = join(model_dir, "candidates", "failed", "validation")
  await mkdir(immutable_artifact_dir, { recursive: true })
  const accepted_source = ".SUBCKT ACCEPTED OUT\nV1 OUT 0 1\n.ENDS ACCEPTED\n"
  const accepted_card = "Accepted card\n"
  const failed_source = ".SUBCKT ACCEPTED OUT\nR1 OUT 0 1k\n.ENDS ACCEPTED\n"
  const failed: GeneratedModel = {
    source: failed_source,
    card: "Failed candidate card\n",
    manifest: createModelManifest({
      model_interface: contract.interface,
      model_source: failed_source,
      simulator: "ngspice",
    }),
  }
  const accepted_manifest = createModelManifest({
    model_interface: contract.interface,
    model_source: accepted_source,
    simulator: "ngspice",
  })
  const accepted_report = '{"version":1,"passed":true,"accepted":true}\n'
  await Promise.all([
    Bun.write(join(model_dir, "model.lib"), accepted_source),
    Bun.write(join(model_dir, "model-card.md"), accepted_card),
    Bun.write(join(model_dir, "model-manifest.json"), `${JSON.stringify(accepted_manifest)}\n`),
    Bun.write(join(model_dir, "validation-results.json"), accepted_report),
  ])
  const store = new ModelRunStore()
  store.createModelRun({
    model_run_id: "accepted_model",
    job_id: "accepted_job",
    model_dir,
    effort_multiplier: 1,
  })
  store.updateModelRun("accepted_model", {
    model_source: accepted_source,
    model_card: accepted_card,
    manifest: accepted_manifest,
  })

  await persistCandidateValidationUi({
    plan,
    result: resultFor(failed, true),
    generated: failed,
    immutable_artifact_dir,
  })

  expect(await readFile(join(model_dir, "model.lib"), "utf8")).toBe(accepted_source)
  expect(await readFile(join(model_dir, "model-card.md"), "utf8")).toBe(accepted_card)
  expect(JSON.parse(await readFile(join(model_dir, "model-manifest.json"), "utf8"))).toEqual(
    accepted_manifest,
  )
  expect(await readFile(join(model_dir, "validation-results.json"), "utf8")).toBe(accepted_report)
  expect(
    JSON.parse(await readFile(join(immutable_artifact_dir, "validation-results.json"), "utf8")),
  ).toMatchObject({
    passed: true,
  })
  expect(store.getModelRun("accepted_model")).toMatchObject({
    model_source: accepted_source,
    model_card: accepted_card,
    manifest: accepted_manifest,
  })
})
