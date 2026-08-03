import { createHash } from "node:crypto"
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentClient } from "@/server/infrastructure/agent"
import { generateModelCandidate } from "@/server/model-workflow/model-candidate"
import { MODEL_CANDIDATE_CHECK_RECEIPT_FILE } from "@/server/model-workflow/model-candidate-check"
import {
  createModelTrainingCheckReceipt,
  MODEL_TRAINING_CHECK_RECEIPT_FILE,
} from "@/server/model-workflow/model-training-check"
import type { ModelTrainingValidationReport } from "@/server/model-workflow/model-training-validation"
import { assertNgspiceAcceptsModelCandidate } from "@/server/model-workflow/model-candidate-smoke"
import { createModelManifest, type ModelContract } from "@/server/modeling"
import { PipelineError } from "@/server/pipeline"
import { executeLocalNgspice, type NgspiceExecutor, type ValidationPlan } from "@/server/spice-validation"

const temporary_directories: string[] = []
const ngspice_path = Bun.which("ngspice")
const testWithNgspice = ngspice_path ? test : test.skip

const smoke_raw = `Title: candidate smoke
Date: Fri Aug  1 00:00:00 2026
Plotname: Operating Point
Flags: real
No. Variables: 1
No. Points: 1
Variables:
  0 v(smoke_1) voltage
Values:
0 0
`

const accepting_ngspice: NgspiceExecutor = async ({ raw_path }) => {
  await Bun.write(raw_path, smoke_raw)
  return {
    exit_code: 0,
    stdout: "candidate accepted\n",
    stderr: "",
    cancelled: false,
  }
}

async function simulateCandidateToolReceipts(input: {
  workspace: string
  source: string
  card: string
  training_validation?: ModelTrainingValidationReport
}): Promise<void> {
  const manifest = createModelManifest({
    model_interface: contract.interface,
    model_source: input.source,
    simulator: "ngspice",
  })
  const candidate_receipt = {
    version: 1 as const,
    status: "passed" as const,
    checks: ["model_contract", "model_card", "ngspice_smoke"] as const,
    revision: manifest.revision,
    entry_name: manifest.entry_name,
    pin_count: manifest.pins.length,
    model_card_sha256: createHash("sha256").update(input.card).digest("hex"),
  }
  const training_receipt = await createModelTrainingCheckReceipt({
    workspace: input.workspace,
    candidate: candidate_receipt,
    training_validation: input.training_validation ?? {
      version: 1,
      status: "passed",
      cases: [],
      error_codes: [],
    },
  })
  await Promise.all([
    Bun.write(
      join(input.workspace, MODEL_CANDIDATE_CHECK_RECEIPT_FILE),
      `${JSON.stringify(candidate_receipt)}\n`,
    ),
    Bun.write(
      join(input.workspace, MODEL_TRAINING_CHECK_RECEIPT_FILE),
      `${JSON.stringify(training_receipt)}\n`,
    ),
  ])
}

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

const validation_plan: ValidationPlan = {
  version: 1,
  model: {
    entry_name: contract.interface.entry_name,
    pins: contract.interface.pins.map(({ spice_node }) => spice_node),
  },
  cases: [],
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
  const application_plan_was_hidden: boolean[] = []
  const candidate_curve_x_values: number[][] = []
  const agent_client: AgentClient = {
    async run(input) {
      stale_model_was_visible.push(await Bun.file(join(input.workspace, "model.lib")).exists())
      application_plan_was_hidden.push(
        !(await Bun.file(join(input.workspace, "typical-application-plan.json")).exists()),
      )
      candidate_curve_x_values.push(
        JSON.parse(
          await Bun.file(join(input.workspace, "model-contract.json")).text(),
        ).characterization.requirements[0].reference_curve.points.map(({ x }: { x: number }) => x),
      )
      const source = sources.shift()
      if (!source) throw new Error("No test model remains")
      const card = "Deterministic test model.\n"
      await Promise.all([
        Bun.write(join(input.workspace, "model.lib"), source),
        Bun.write(join(input.workspace, "model-card.md"), card),
      ])
      await simulateCandidateToolReceipts({ workspace: input.workspace, source, card })
      return { attempts: 1, duration_ms: 1, output_tail: "" }
    },
  }
  const common = {
    model_dir,
    contract,
    validation_plan,
    evidence_dir: join(model_dir, "evidence"),
    strategy_guidance: "Use a dependent source.",
    stage_id: "generate_model" as const,
    phase_label: "test generation",
    signal: new AbortController().signal,
    use_openai: false,
    agent_client,
    ngspice: accepting_ngspice,
    ngspice_path: "ngspice-test",
    tsci_path: "tsci-test",
    max_artifact_attempts: 1,
    debug_dir: join(model_dir, "debug"),
    on_output: () => undefined,
  }

  const first = await generateModelCandidate(common)
  const first_source = await readFile(join(first.value.artifact_dir, "model.lib"), "utf8")
  const second = await generateModelCandidate(common)

  expect(stale_model_was_visible).toEqual([false, false])
  expect(application_plan_was_hidden).toEqual([true, true])
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

test("repair candidates receive the failed candidate and public training plan but not private validation results", async () => {
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
  let training_plan_was_visible = false
  let repair_curve_x_values: number[] = []
  const agent_client: AgentClient = {
    async run(input) {
      received_previous_artifacts =
        (await Bun.file(join(input.workspace, "model.lib")).text()) === previous_source &&
        (await Bun.file(join(input.workspace, "model-card.md")).exists())
      validation_artifacts_were_hidden =
        !(await Bun.file(join(input.workspace, "validation-plan.json")).exists()) &&
        !(await Bun.file(join(input.workspace, "validation-results.json")).exists())
      training_plan_was_visible = await Bun.file(join(input.workspace, "model-training-plan.json")).exists()
      repair_curve_x_values = JSON.parse(
        await Bun.file(join(input.workspace, "model-contract.json")).text(),
      ).characterization.requirements[0].reference_curve.points.map(({ x }: { x: number }) => x)
      const source = ".SUBCKT GAIN IN OUT\nE1 OUT 0 IN 0 3\n.ENDS GAIN\n"
      const card = "Repaired model.\n"
      await Promise.all([
        Bun.write(join(input.workspace, "model.lib"), source),
        Bun.write(join(input.workspace, "model-card.md"), card),
      ])
      await simulateCandidateToolReceipts({ workspace: input.workspace, source, card })
      return { attempts: 1, duration_ms: 1, output_tail: "" }
    },
  }

  await generateModelCandidate({
    model_dir,
    contract,
    validation_plan,
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
    ngspice: accepting_ngspice,
    ngspice_path: "ngspice-test",
    tsci_path: "tsci-test",
    max_artifact_attempts: 1,
    debug_dir: join(model_dir, "debug"),
    on_output: () => undefined,
  })

  expect(received_previous_artifacts).toBe(true)
  expect(validation_artifacts_were_hidden).toBe(true)
  expect(training_plan_was_visible).toBe(true)
  expect(repair_curve_x_values).toEqual([0, 1, 3, 5, 6])
})

test("model candidate validation bounds agent-owned source before parsing it", async () => {
  const model_dir = await prepareModelDirectory()
  const error = await generateModelCandidate({
    model_dir,
    contract,
    validation_plan,
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
    ngspice: accepting_ngspice,
    ngspice_path: "ngspice-test",
    tsci_path: "tsci-test",
    max_artifact_attempts: 1,
    debug_dir: join(model_dir, "debug-bounded"),
    on_output: () => undefined,
  }).catch((caught) => caught)

  expect(error).toBeInstanceOf(PipelineError)
  expect((error as PipelineError).diagnostic.code).toBe("generate_model_artifact_invalid")
  expect((error as Error).message).toContain("unexpectedly large")
  expect(await Bun.file(join(model_dir, "candidates")).exists()).toBe(false)
})

test("candidate acceptance requires a passed self-check receipt for the final file contents", async () => {
  const model_dir = await prepareModelDirectory()
  const source = ".SUBCKT GAIN IN OUT\nE1 OUT 0 IN 0 1\n.ENDS GAIN\n"
  const checked_card = "Checked card.\n"
  const error = await generateModelCandidate({
    model_dir,
    contract,
    validation_plan,
    evidence_dir: join(model_dir, "evidence"),
    strategy_guidance: "Use a dependent source.",
    stage_id: "generate_model",
    phase_label: "test final self-check receipt",
    signal: new AbortController().signal,
    use_openai: false,
    agent_client: {
      async run(input) {
        await Promise.all([
          Bun.write(join(input.workspace, "model.lib"), source),
          Bun.write(join(input.workspace, "model-card.md"), checked_card),
        ])
        await simulateCandidateToolReceipts({ workspace: input.workspace, source, card: checked_card })
        await Bun.write(join(input.workspace, "model-card.md"), "Changed after the check.\n")
        return { attempts: 1, duration_ms: 1, output_tail: "" }
      },
    },
    ngspice: accepting_ngspice,
    ngspice_path: "ngspice-test",
    tsci_path: "tsci-test",
    max_artifact_attempts: 1,
    debug_dir: join(model_dir, "debug-final-receipt"),
    on_output: () => undefined,
  }).catch((caught) => caught)

  expect(error).toBeInstanceOf(PipelineError)
  expect((error as Error).message).toContain("changed after check_model_candidate passed")
  expect(await Bun.file(join(model_dir, "candidates")).exists()).toBe(false)
})

test("candidate acceptance rejects a smoke-passed model with no public ngspice comparison", async () => {
  const model_dir = await prepareModelDirectory()
  const source = ".SUBCKT GAIN IN OUT\nE1 OUT 0 IN 0 1\n.ENDS GAIN\n"
  const card = "Smoke-valid but training-invalid model.\n"
  const error = await generateModelCandidate({
    model_dir,
    contract,
    validation_plan,
    evidence_dir: join(model_dir, "evidence"),
    strategy_guidance: "Use a dependent source.",
    stage_id: "generate_model",
    phase_label: "test mandatory public training gate",
    signal: new AbortController().signal,
    use_openai: false,
    agent_client: {
      async run(input) {
        await Promise.all([
          Bun.write(join(input.workspace, "model.lib"), source),
          Bun.write(join(input.workspace, "model-card.md"), card),
        ])
        await simulateCandidateToolReceipts({
          workspace: input.workspace,
          source,
          card,
          training_validation: {
            version: 1,
            status: "failed",
            cases: [],
            error_codes: ["viewer_validation_unavailable"],
          },
        })
        return { attempts: 1, duration_ms: 1, output_tail: "" }
      },
    },
    ngspice: accepting_ngspice,
    ngspice_path: "ngspice-test",
    tsci_path: "tsci-test",
    max_artifact_attempts: 1,
    debug_dir: join(model_dir, "debug-training-receipt"),
    on_output: () => undefined,
  }).catch((caught) => caught)

  expect(error).toBeInstanceOf(PipelineError)
  expect((error as Error).message).toContain("viewer_validation_unavailable")
  expect(await Bun.file(join(model_dir, "candidates")).exists()).toBe(false)
})

test("ngspice syntax rejection is corrected inside candidate generation with a safe diagnostic", async () => {
  const model_dir = await prepareModelDirectory()
  const prompts: string[] = []
  const system_output: string[] = []
  let agent_attempt = 0
  const result = await generateModelCandidate({
    model_dir,
    contract,
    validation_plan,
    evidence_dir: join(model_dir, "evidence"),
    strategy_guidance: "Use a dependent source.",
    stage_id: "generate_model",
    phase_label: "test syntax correction",
    signal: new AbortController().signal,
    use_openai: false,
    agent_client: {
      async run(input) {
        prompts.push(input.prompt)
        agent_attempt += 1
        const source =
          agent_attempt === 1
            ? ".SUBCKT GAIN IN OUT\nB1 OUT 0 V=if(V(IN)>0,1,0)\n.ENDS GAIN\n"
            : ".SUBCKT GAIN IN OUT\nE1 OUT 0 IN 0 2\n.ENDS GAIN\n"
        const card = "Candidate model.\n"
        await Promise.all([
          Bun.write(join(input.workspace, "model.lib"), source),
          Bun.write(join(input.workspace, "model-card.md"), card),
        ])
        await simulateCandidateToolReceipts({ workspace: input.workspace, source, card })
        return { attempts: 1, duration_ms: 1, output_tail: "" }
      },
    },
    ngspice: async ({ cwd, raw_path }) => {
      const source = await Bun.file(join(cwd, "../model.lib")).text()
      if (source.includes("if(")) {
        return {
          exit_code: 1,
          stdout: "",
          stderr: `Error: no such function 'if' at line 2\nfrom file\n  ${model_dir}/private/model.lib\nERROR: fatal error in ngspice, exit(1)\n`,
          cancelled: false,
        }
      }
      await Bun.write(raw_path, smoke_raw)
      return { exit_code: 0, stdout: "accepted\n", stderr: "", cancelled: false }
    },
    ngspice_path: "ngspice-test",
    tsci_path: "tsci-test",
    max_artifact_attempts: 2,
    debug_dir: join(model_dir, "debug-syntax"),
    on_output: (stream, message) => {
      if (stream === "system") system_output.push(message)
    },
  })

  expect(agent_attempt).toBe(2)
  expect(result.value.source).toContain("E1 OUT 0 IN 0 2")
  expect(prompts[1]).toContain("no such function 'if' at line 2")
  expect(prompts[1]).not.toContain(model_dir)
  expect(system_output.join("\n")).toContain("candidate smoke validation")
})

testWithNgspice(
  "real ngspice smoke rejects the unsupported if function before private validation",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "model-smoke-real-"))
    temporary_directories.push(workspace)
    const source = ".SUBCKT GAIN IN OUT\nB1 OUT 0 V=if(V(IN)>0,1,0)\n.ENDS GAIN\n"
    await Bun.write(join(workspace, "model.lib"), source)
    const manifest = createModelManifest({
      model_interface: contract.interface,
      model_source: source,
      simulator: "ngspice",
    })

    const error = await assertNgspiceAcceptsModelCandidate({
      workspace,
      manifest,
      ngspice: executeLocalNgspice,
      ngspice_path: ngspice_path ?? "ngspice",
      signal: new AbortController().signal,
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("no such function 'if' at line 2")
    expect((error as Error).message).not.toContain(workspace)
  },
)

test("candidate smoke rejects fatal output even when ngspice exits zero", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "model-smoke-zero-exit-fatal-"))
  temporary_directories.push(workspace)
  const source = ".SUBCKT GAIN IN OUT\nR1 IN OUT 1k\n.ENDS GAIN\n"
  await Bun.write(join(workspace, "model.lib"), source)
  const manifest = createModelManifest({
    model_interface: contract.interface,
    model_source: source,
    simulator: "ngspice",
  })

  await expect(
    assertNgspiceAcceptsModelCandidate({
      workspace,
      manifest,
      ngspice: async () => ({
        exit_code: 0,
        stdout: "doAnalyses: run simulation(s) aborted",
        stderr: "fatal error: analysis failed",
        cancelled: false,
      }),
      ngspice_path: "ngspice-test",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/fatal error: analysis failed/)
})

test("candidate smoke rejects a zero-exit run with no raw operating point", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "model-smoke-missing-raw-"))
  temporary_directories.push(workspace)
  const source = ".SUBCKT GAIN IN OUT\nR1 IN OUT 1k\n.ENDS GAIN\n"
  await Bun.write(join(workspace, "model.lib"), source)
  const manifest = createModelManifest({
    model_interface: contract.interface,
    model_source: source,
    simulator: "ngspice",
  })

  await expect(
    assertNgspiceAcceptsModelCandidate({
      workspace,
      manifest,
      ngspice: async () => ({
        exit_code: 0,
        stdout: "completed without a raw file",
        stderr: "",
        cancelled: false,
      }),
      ngspice_path: "ngspice-test",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/no valid operating-point result/)
})
