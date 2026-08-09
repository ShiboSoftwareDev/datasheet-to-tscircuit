import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentClient } from "@/server/infrastructure/agent"
import { generateRepairCandidate } from "@/server/model-workflow/repair-candidate"
import { createModelManifest, type ModelContract, renderValidationCaseTsx } from "@/server/modeling"
import type { ValidationPlan } from "@/server/spice-validation"

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(temporary_directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const contract: ModelContract = {
  version: 1,
  interface: {
    version: 1,
    part_number: "TEST-GAIN",
    entry_name: "GAIN",
    pins: [
      {
        physical_pin: "1",
        component_pin: "pin1",
        source_port_id: "source_port_1",
        spice_node: "IN",
        labels: ["IN"],
        role: "input",
      },
      {
        physical_pin: "2",
        component_pin: "pin2",
        source_port_id: "source_port_2",
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
    requirements: [],
    assumptions: [],
    limitations: [],
  },
}

const plan: ValidationPlan = {
  version: 1,
  model: { entry_name: "GAIN", pins: ["IN", "OUT"] },
  cases: [
    {
      id: "startup",
      title: "Startup",
      requirement_ids: ["startup"],
      nets: [],
      fixtures: [
        {
          type: "voltage_source",
          id: "input",
          positive: "dut.IN",
          negative: "gnd",
          dc_volts: 1,
        },
      ],
      analysis: { type: "transient", step: 0.001, stop: 0.002 },
      observations: [
        {
          id: "VOUT",
          requirement_id: "startup",
          type: "voltage",
          positive: "dut.OUT",
          negative: "gnd",
          unit: "V",
          scale: "linear",
          reference: {
            type: "curve",
            tolerance: 0.1,
            points: [
              { x: 0, y: 0 },
              { x: 0.002, y: 1 },
            ],
          },
        },
      ],
    },
  ],
}

async function prepareRepair(input: {
  mutate: (workspace: string, next_source: string, next_card: string) => Promise<void>
}) {
  const model_dir = await mkdtemp(join(tmpdir(), "model-repair-candidate-"))
  temporary_directories.push(model_dir)
  const previous_dir = join(model_dir, "candidates", "previous")
  const source_dir = join(previous_dir, "simulation-tsx")
  const validation_dir = join(previous_dir, "validation")
  const evidence_dir = join(model_dir, "evidence")
  await Promise.all([
    mkdir(source_dir, { recursive: true }),
    mkdir(validation_dir, { recursive: true }),
    mkdir(evidence_dir, { recursive: true }),
  ])
  const previous_source = ".SUBCKT GAIN IN OUT\nE1 OUT 0 IN 0 1\n.ENDS GAIN\n"
  const previous_card = "# Baseline model\n"
  const previous_manifest = createModelManifest({
    model_interface: contract.interface,
    model_source: previous_source,
    simulator: "ngspice",
  })
  const previous_tsx = renderValidationCaseTsx({
    validation_case: plan.cases[0]!,
    manifest: previous_manifest,
    model_source: previous_source,
    model_card: previous_card,
  })
  await Promise.all([
    Bun.write(join(model_dir, "AGENTS.md"), "isolated repair workspace\n"),
    Bun.write(join(model_dir, "model-interface.json"), JSON.stringify(contract.interface)),
    Bun.write(join(model_dir, "model-contract.json"), JSON.stringify(contract)),
    Bun.write(join(previous_dir, "model.lib"), previous_source),
    Bun.write(join(previous_dir, "model-card.md"), previous_card),
    Bun.write(join(source_dir, "startup.circuit.tsx"), previous_tsx),
    Bun.write(join(validation_dir, "validation-plan.json"), JSON.stringify(plan)),
    Bun.write(join(validation_dir, "validation-results.json"), JSON.stringify({ passed: false })),
    Bun.write(join(validation_dir, "candidate-diagnostics.json"), JSON.stringify({ failed: true })),
    Bun.write(join(validation_dir, "model-ui.json"), JSON.stringify({ version: 1 })),
  ])

  const next_source = ".SUBCKT GAIN IN OUT\nE1 OUT 0 IN 0 2\n.ENDS GAIN\n"
  const next_card = "# Repaired model\n"
  const agent_client: AgentClient = {
    async run(agent_input) {
      await input.mutate(agent_input.workspace, next_source, next_card)
      return { attempts: 1, duration_ms: 1, output_tail: "" }
    },
  }
  return {
    result: generateRepairCandidate({
      model_dir,
      contract,
      plan,
      evidence_dir,
      previous: {
        model_path: join(previous_dir, "model.lib"),
        model_card_path: join(previous_dir, "model-card.md"),
        source_dir,
        result_path: join(validation_dir, "validation-results.json"),
      },
      strategy_guidance: "Use a causal dependent source.",
      feedback: "The gain is too low.",
      signal: new AbortController().signal,
      use_openai: false,
      agent_client,
      max_artifact_attempts: 1,
      debug_dir: join(model_dir, "debug"),
      phase_label: "test repair",
      on_output: () => undefined,
    }),
    next_source,
    previous_tsx,
  }
}

test("repair binds the canonical changed model into unchanged TSX circuits", async () => {
  const prepared = await prepareRepair({
    async mutate(workspace, next_source, next_card) {
      const tsx_path = join(workspace, "simulation-tsx", "startup.circuit.tsx")
      const tsx = await readFile(tsx_path, "utf8")
      await Promise.all([
        Bun.write(join(workspace, "model.lib"), next_source),
        Bun.write(join(workspace, "model-card.md"), next_card),
        Bun.write(
          join(workspace, "repair-plan.json"),
          JSON.stringify({
            version: 1,
            target: "model",
            affected_case_ids: ["startup"],
            diagnosis: "The model gain is too low.",
            planned_changes: ["Increase the model gain."],
          }),
        ),
        // A stale or agent-edited embedded copy is metadata, not a circuit edit.
        Bun.write(tsx_path, tsx.replace(/^const modelSource = .*$/m, 'const modelSource = "stale"')),
      ])
    },
  })
  const candidate = await prepared.result
  const promoted_tsx = await readFile(join(candidate.value.source_dir, "startup.circuit.tsx"), "utf8")

  expect(promoted_tsx).toContain(`const modelSource = ${JSON.stringify(prepared.next_source)}`)
  expect(promoted_tsx).not.toContain('const modelSource = "stale"')
  expect(promoted_tsx).toContain(` * Model revision: ${candidate.value.manifest.revision}`)
})

test("repair rejects edits to the embedded immutable validation contract", async () => {
  const prepared = await prepareRepair({
    async mutate(workspace, next_source, next_card) {
      const tsx_path = join(workspace, "simulation-tsx", "startup.circuit.tsx")
      const tsx = await readFile(tsx_path, "utf8")
      await Promise.all([
        Bun.write(join(workspace, "model.lib"), next_source),
        Bun.write(join(workspace, "model-card.md"), next_card),
        Bun.write(
          join(workspace, "repair-plan.json"),
          JSON.stringify({
            version: 1,
            target: "model",
            affected_case_ids: ["startup"],
            diagnosis: "The model gain is too low.",
            planned_changes: ["Increase the model gain."],
          }),
        ),
        Bun.write(tsx_path, tsx.replace('"tolerance": 0.1', '"tolerance": 9')),
      ])
    },
  })

  await expect(prepared.result).rejects.toThrow(/immutable validationCaseContract changed/)
})
