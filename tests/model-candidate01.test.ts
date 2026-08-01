import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentClient } from "@/server/infrastructure/agent"
import { generateModelCandidate } from "@/server/model-workflow/model-candidate"
import type { ModelContract } from "@/server/modeling"
import { PipelineError } from "@/server/pipeline"

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
    requirements: [
      {
        requirement_id: "transfer_curve",
        title: "Transfer curve",
        behavior: "Produce a smooth documented transfer response",
        analysis: "dc_sweep",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "V", min: 0, max: 6 },
        reference_curve: {
          x_quantity: "input voltage",
          x_unit: "V",
          y_quantity: "output voltage",
          y_unit: "V",
          points: Array.from({ length: 7 }, (_, value) => ({ x: value, y: value })),
        },
        sources: [{ page: 1, locator: "Figure 1", statement: "Documented transfer curve" }],
      },
    ],
    assumptions: [],
    limitations: [],
  },
}

const typical_application_plan = {
  version: 4,
  availability: "not_present",
  title: "No documented application",
  description: "The fixture has no documented application circuit.",
  source_references: [{ page: 1, method: "pdf_text", confidence: "high" }],
  searched_sections: ["application information"],
  components: [],
  connections: [],
}

async function prepareModelDirectory(): Promise<string> {
  const model_dir = await mkdtemp(join(tmpdir(), "model-candidate-"))
  temporary_directories.push(model_dir)
  await mkdir(join(model_dir, "evidence"), { recursive: true })
  await Promise.all([
    Bun.write(join(model_dir, "AGENTS.md"), "server-owned workspace\n"),
    Bun.write(join(model_dir, "model-contract.json"), JSON.stringify(contract)),
    Bun.write(join(model_dir, "model-interface.json"), JSON.stringify(contract.interface)),
    Bun.write(join(model_dir, "validation-plan.json"), JSON.stringify({ version: 1, model: {}, cases: [] })),
    Bun.write(join(model_dir, "validation-plan-guide.md"), "guide\n"),
    Bun.write(join(model_dir, "component.circuit.tsx"), "export default () => <chip />\n"),
    Bun.write(join(model_dir, "component-evidence.json"), "{}\n"),
    Bun.write(
      join(model_dir, "typical-application-plan.json"),
      `${JSON.stringify(typical_application_plan, null, 2)}\n`,
    ),
  ])
  return model_dir
}

test("fresh candidates ignore stale model output and preserve accepted revisions immutably", async () => {
  const model_dir = await prepareModelDirectory()
  const accepted_source = ".SUBCKT GAIN IN OUT\nE1 OUT 0 IN 0 9\n.ENDS GAIN\n"
  await Promise.all([
    Bun.write(join(model_dir, "model.lib"), accepted_source),
    Bun.write(join(model_dir, "model-card.md"), "Accepted model.\n"),
  ])
  const sources = [
    ".SUBCKT GAIN IN OUT\nE1 OUT 0 IN 0 1\n.ENDS GAIN\n",
    ".SUBCKT GAIN IN OUT\nE1 OUT 0 IN 0 2\n.ENDS GAIN\n",
  ]
  const stale_model_was_visible: boolean[] = []
  const application_plan_was_visible: boolean[] = []
  const candidate_curve_x_values: number[][] = []
  const agent_client: AgentClient = {
    async run(input) {
      stale_model_was_visible.push(await Bun.file(join(input.workspace, "model.lib")).exists())
      application_plan_was_visible.push(
        JSON.parse(await Bun.file(join(input.workspace, "typical-application-plan.json")).text())
          .availability === "not_present",
      )
      candidate_curve_x_values.push(
        JSON.parse(
          await Bun.file(join(input.workspace, "model-contract.json")).text(),
        ).characterization.requirements[0].reference_curve.points.map(({ x }: { x: number }) => x),
      )
      const source = sources.shift()
      if (!source) throw new Error("No test model remains")
      await Promise.all([
        Bun.write(join(input.workspace, "model.lib"), source),
        Bun.write(join(input.workspace, "model-card.md"), "Deterministic test model.\n"),
      ])
      return { attempts: 1, duration_ms: 1, output_tail: "" }
    },
  }
  const common = {
    model_dir,
    contract,
    evidence_dir: join(model_dir, "evidence"),
    strategy_guidance: "Use a dependent source.",
    stage_id: "generate_model" as const,
    phase_label: "test generation",
    signal: new AbortController().signal,
    use_openai: false,
    agent_client,
    max_artifact_attempts: 1,
    debug_dir: join(model_dir, "debug"),
    on_output: () => undefined,
  }

  const first = await generateModelCandidate(common)
  const first_source = await readFile(join(first.value.artifact_dir, "model.lib"), "utf8")
  const second = await generateModelCandidate(common)

  expect(stale_model_was_visible).toEqual([false, false])
  expect(application_plan_was_visible).toEqual([true, true])
  expect(candidate_curve_x_values).toEqual([
    [0, 1, 3, 5, 6],
    [0, 1, 3, 5, 6],
  ])
  expect(
    JSON.parse(
      await readFile(join(model_dir, "model-contract.json"), "utf8"),
    ).characterization.requirements[0].reference_curve.points.map(({ x }: { x: number }) => x),
  ).toEqual([0, 1, 2, 3, 4, 5, 6])
  expect(first.value.artifact_dir).not.toBe(second.value.artifact_dir)
  expect(await readFile(join(first.value.artifact_dir, "model.lib"), "utf8")).toBe(first_source)
  expect(await readFile(join(second.value.artifact_dir, "model.lib"), "utf8")).not.toBe(first_source)
  expect(await readFile(join(model_dir, "model.lib"), "utf8")).toBe(accepted_source)
  expect(await readFile(join(model_dir, "model-card.md"), "utf8")).toBe("Accepted model.\n")
})

test("repair candidates receive the failed candidate but not private validation fixtures", async () => {
  const model_dir = await prepareModelDirectory()
  const previous_source = ".SUBCKT GAIN IN OUT\nE1 OUT 0 IN 0 1\n.ENDS GAIN\n"
  const previous_dir = join(model_dir, "candidates", "previous")
  await mkdir(previous_dir, { recursive: true })
  await Promise.all([
    Bun.write(join(model_dir, "model.lib"), ".SUBCKT GAIN IN OUT\nE1 OUT 0 IN 0 9\n.ENDS GAIN\n"),
    Bun.write(join(model_dir, "model-card.md"), "Accepted model.\n"),
    Bun.write(join(previous_dir, "model.lib"), previous_source),
    Bun.write(join(previous_dir, "model-card.md"), "Previous candidate.\n"),
    Bun.write(join(model_dir, "validation-results.json"), '{"passed":false}\n'),
  ])
  let received_previous_artifacts = false
  let validation_artifacts_were_hidden = false
  let repair_curve_x_values: number[] = []
  const agent_client: AgentClient = {
    async run(input) {
      received_previous_artifacts =
        (await Bun.file(join(input.workspace, "model.lib")).text()) === previous_source &&
        (await Bun.file(join(input.workspace, "model-card.md")).exists())
      validation_artifacts_were_hidden =
        !(await Bun.file(join(input.workspace, "validation-plan.json")).exists()) &&
        !(await Bun.file(join(input.workspace, "validation-results.json")).exists())
      repair_curve_x_values = JSON.parse(
        await Bun.file(join(input.workspace, "model-contract.json")).text(),
      ).characterization.requirements[0].reference_curve.points.map(({ x }: { x: number }) => x)
      await Promise.all([
        Bun.write(join(input.workspace, "model.lib"), ".SUBCKT GAIN IN OUT\nE1 OUT 0 IN 0 3\n.ENDS GAIN\n"),
        Bun.write(join(input.workspace, "model-card.md"), "Repaired model.\n"),
      ])
      return { attempts: 1, duration_ms: 1, output_tail: "" }
    },
  }

  await generateModelCandidate({
    model_dir,
    contract,
    evidence_dir: join(model_dir, "evidence"),
    previous_candidate: {
      model_path: join(previous_dir, "model.lib"),
      model_card_path: join(previous_dir, "model-card.md"),
    },
    strategy_guidance: "Use a dependent source.",
    feedback: "The gain was too low.",
    stage_id: "repair_model",
    phase_label: "test repair",
    signal: new AbortController().signal,
    use_openai: false,
    agent_client,
    max_artifact_attempts: 1,
    debug_dir: join(model_dir, "debug"),
    on_output: () => undefined,
  })

  expect(received_previous_artifacts).toBe(true)
  expect(validation_artifacts_were_hidden).toBe(true)
  expect(repair_curve_x_values).toEqual([0, 1, 3, 5, 6])
})

test("model candidate validation bounds agent-owned source before parsing it", async () => {
  const model_dir = await prepareModelDirectory()
  const error = await generateModelCandidate({
    model_dir,
    contract,
    evidence_dir: join(model_dir, "evidence"),
    strategy_guidance: "Use a dependent source.",
    stage_id: "generate_model",
    phase_label: "test bounded generation",
    signal: new AbortController().signal,
    use_openai: false,
    agent_client: {
      async run(input) {
        await Promise.all([
          Bun.write(join(input.workspace, "model.lib"), new Uint8Array(2 * 1024 * 1024 + 1)),
          Bun.write(join(input.workspace, "model-card.md"), "Oversized candidate.\n"),
        ])
        return { attempts: 1, duration_ms: 1, output_tail: "" }
      },
    },
    max_artifact_attempts: 1,
    debug_dir: join(model_dir, "debug-bounded"),
    on_output: () => undefined,
  }).catch((caught) => caught)

  expect(error).toBeInstanceOf(PipelineError)
  expect((error as PipelineError).diagnostic.code).toBe("generate_model_artifact_invalid")
  expect((error as Error).message).toContain("unexpectedly large")
  expect(await Bun.file(join(model_dir, "candidates")).exists()).toBe(false)
})
