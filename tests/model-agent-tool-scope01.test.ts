import { afterEach, expect, test } from "bun:test"
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModelCandidateFileTools } from "../src/server/infrastructure/agent/model-candidate-tools-extension"
import { ModelCandidateCheckError } from "../src/server/model-workflow/model-candidate-check"
import { MODEL_TRAINING_CHECK_RECEIPT_FILE } from "../src/server/model-workflow/model-training-check"

const temporary_directories: string[] = []
const ngspice_path = Bun.which("ngspice")
const testWithNgspice = ngspice_path ? test : test.skip

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporary_directories.push(directory)
  return directory
}

async function executeTool(tool: unknown, parameters: Record<string, unknown>) {
  return (tool as { execute: (...args: unknown[]) => Promise<unknown> }).execute(
    "test-call",
    parameters,
    new AbortController().signal,
    () => undefined,
    undefined,
  )
}

test("model candidate tools are visible to the agent under their scoped capability names", async () => {
  const workspace = await makeTemporaryDirectory("model-tools-workspace-")
  const [read_tool, write_tool, check_tool, fit_tool] = createModelCandidateFileTools(workspace)

  expect(read_tool.name).toBe("workspace_read")
  expect(read_tool.label).toBe("workspace_read")
  expect(read_tool.description).toContain("isolated model-candidate workspace")
  expect(read_tool.description).not.toContain("bash")
  expect(read_tool.promptSnippet).toContain("isolated model-candidate workspace")
  expect(read_tool.promptGuidelines).toEqual([
    "Use workspace_read to inspect declared candidate-workspace inputs.",
  ])

  expect(write_tool.name).toBe("model_output_write")
  expect(write_tool.label).toBe("model_output_write")
  expect(write_tool.description).toContain("model.lib or model-card.md")
  expect(write_tool.promptSnippet).toContain("model.lib or model-card.md")
  expect(write_tool.promptGuidelines).toEqual([
    "Use model_output_write only for model.lib and model-card.md.",
  ])

  expect(check_tool.name).toBe("check_model_candidate")
  expect(check_tool.description).toContain("Statically validate")
  expect(check_tool.description).toContain("standalone tscircuit stages")
  expect(check_tool.promptGuidelines).toEqual([
    "After writing model.lib and model-card.md, call check_model_candidate and correct any failed diagnostic before finishing.",
  ])

  expect(fit_tool.name).toBe("fit_model_parameters")
  expect(fit_tool.description).toContain("numeric .param declarations")
  expect(fit_tool.description).toContain("real ngspice")
  expect(fit_tool.description).toContain("never sees held-out samples")
  expect(fit_tool.description).toContain("no paths or commands")
  expect(fit_tool.promptGuidelines).toEqual([
    "Use fit_model_parameters for numeric calibration after a structurally valid causal model exists, then rerun check_model_candidate.",
  ])
})

test("model parameter fitter receives only bounded declarations and returns a traceable result", async () => {
  const workspace = await makeTemporaryDirectory("model-tools-fit-")
  const invocations: Array<Record<string, unknown>> = []
  const [, , , fit_tool] = createModelCandidateFileTools(workspace, {
    ngspice_path: "/trusted/ngspice",
    fit_parameters: async (input) => {
      invocations.push({
        workspace: input.workspace,
        ngspice_path: input.ngspice_path,
        parameters: input.parameters,
        max_evaluations: input.max_evaluations,
      })
      const evaluation = {
        values: { LOOP_GAIN: 2 },
        score: {
          runnable: true,
          failed_series_count: 0,
          worst_normalized_max_error: 0.02,
          mean_normalized_rmse: 0.01,
        },
      }
      return { evaluations: 7, initial: evaluation, best: evaluation, improvements: [evaluation] }
    },
  })

  const result = (await executeTool(fit_tool, {
    parameters: [{ name: "LOOP_GAIN", min: 0.1, max: 10, scale: "log" }],
    max_evaluations: 7,
  })) as { details: { status: string; evaluations: number } }

  expect(result.details).toMatchObject({ status: "completed", evaluations: 7 })
  expect(invocations).toEqual([
    {
      workspace: await realpath(workspace),
      ngspice_path: "/trusted/ngspice",
      parameters: [{ name: "LOOP_GAIN", min: 0.1, max: 10, scale: "log" }],
      max_evaluations: 7,
    },
  ])
})

test("model candidate check has no agent-controlled command or path and returns a typed receipt", async () => {
  const workspace = await makeTemporaryDirectory("model-tools-workspace-")
  const invocations: Array<{ workspace: string; ngspice_path: string }> = []
  const [, , check_tool] = createModelCandidateFileTools(workspace, {
    ngspice_path: "/trusted/ngspice",
    check_candidate: async (input) => {
      invocations.push({ workspace: input.workspace, ngspice_path: input.ngspice_path })
      return {
        version: 1,
        status: "passed",
        checks: ["model_contract", "model_card", "ngspice_smoke"],
        revision: "a".repeat(16),
        entry_name: "SAFE_MODEL",
        pin_count: 2,
        model_card_sha256: "b".repeat(64),
      }
    },
  })

  const result = (await executeTool(check_tool, {})) as {
    content: Array<{ type: string; text?: string }>
    details: { status: string; revision: string }
  }

  expect(invocations).toEqual([{ workspace: await realpath(workspace), ngspice_path: "/trusted/ngspice" }])
  expect(result.details).toMatchObject({ status: "passed", revision: "a".repeat(16) })
  expect(result.content[0]?.text).toContain('"status": "passed"')
  expect(await Bun.file(join(workspace, ".candidate-check.json")).exists()).toBe(true)
})

test("model candidate check runs the fixed public training gate and retains integrity-bound results", async () => {
  const workspace = await makeTemporaryDirectory("model-tools-training-check-")
  await writeFile(join(workspace, "model-training-plan.json"), '{"version":1}\n')
  const training_invocations: Array<{ ngspice_path: string; tsci_path: string }> = []
  const candidate = {
    version: 1 as const,
    status: "passed" as const,
    checks: ["model_contract", "model_card", "ngspice_smoke"] as const,
    revision: "a".repeat(16),
    entry_name: "SAFE_MODEL",
    pin_count: 2,
    model_card_sha256: "b".repeat(64),
  }
  const [, , check_tool] = createModelCandidateFileTools(workspace, {
    ngspice_path: "/trusted/ngspice",
    tsci_path: "/trusted/tsci",
    check_candidate: async () => candidate,
    check_training: async ({ ngspice_path, tsci_path }) => {
      training_invocations.push({ ngspice_path, tsci_path })
      return {
        version: 1,
        status: "failed",
        cases: [
          {
            case_id: "visible_case",
            status: "failed",
            server_series: [
              {
                observation_id: "visible_output",
                status: "failed",
                metrics: { sample_count: 1, normalized_max_error: 2 },
                samples: [{ x: 0, reference_y: 3.3, simulated_y: 0, error: -3.3 }],
                error_codes: ["curve_tolerance_exceeded"],
              },
            ],
            viewer_series: [],
            error_codes: ["viewer_validation_unavailable"],
          },
        ],
        error_codes: ["curve_tolerance_exceeded", "viewer_validation_unavailable"],
      }
    },
  })

  const result = (await executeTool(check_tool, {})) as {
    details: {
      status: string
      code: string
      candidate: { revision: string }
      training_validation: { cases: Array<{ case_id: string }> }
    }
  }

  expect(training_invocations).toEqual([{ ngspice_path: "/trusted/ngspice", tsci_path: "/trusted/tsci" }])
  expect(result.details).toMatchObject({
    status: "failed",
    code: "visible_training_validation_failed",
    candidate: { revision: "a".repeat(16) },
    training_validation: { cases: [{ case_id: "visible_case" }] },
  })
  expect(JSON.parse(await readFile(join(workspace, ".candidate-check.json"), "utf8"))).toEqual(candidate)
  expect(
    JSON.parse(await readFile(join(workspace, MODEL_TRAINING_CHECK_RECEIPT_FILE), "utf8")),
  ).toMatchObject({
    version: 1,
    status: "failed",
    candidate,
    training_plan_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    training_validation: { status: "failed", cases: [{ case_id: "visible_case" }] },
  })
})

test("model candidate check restores the best complete candidate after a regression", async () => {
  const workspace = await makeTemporaryDirectory("model-tools-best-candidate-")
  const first_source = ".SUBCKT SAFE_MODEL A B\n.param R=1\nR1 A B {R}\n.ENDS SAFE_MODEL\n"
  const regressed_source = ".SUBCKT SAFE_MODEL A B\n.param R=2\nR1 A B {R}\n.ENDS SAFE_MODEL\n"
  await Promise.all([
    writeFile(join(workspace, "model.lib"), first_source),
    writeFile(join(workspace, "model-card.md"), "first card\n"),
    writeFile(join(workspace, "model-training-plan.json"), '{"version":1}\n'),
  ])
  let check_index = 0
  const training_errors = [0.2, 0.4]
  const [_, write_tool, check_tool] = createModelCandidateFileTools(workspace, {
    check_candidate: async () => {
      check_index += 1
      return {
        version: 1,
        status: "passed",
        checks: ["model_contract", "model_card", "ngspice_smoke"],
        revision: (check_index === 1 ? "a" : "c").repeat(16),
        entry_name: "SAFE_MODEL",
        pin_count: 2,
        model_card_sha256: (check_index === 1 ? "b" : "d").repeat(64),
      }
    },
    check_training: async () => {
      const error = training_errors[check_index - 1]!
      const series = {
        observation_id: "vout",
        status: "failed" as const,
        metrics: { sample_count: 1, normalized_max_error: error, normalized_rmse: error / 2 },
        samples: [{ x: 0, reference_y: 3.3, simulated_y: 3.3 + error, error }],
        error_codes: ["curve_tolerance_exceeded"],
      }
      return {
        version: 1,
        status: "failed" as const,
        cases: [
          {
            case_id: "visible_case",
            status: "failed" as const,
            server_series: [series],
            viewer_series: [series],
            error_codes: [],
          },
        ],
        error_codes: ["curve_tolerance_exceeded"],
      }
    },
  })

  await executeTool(check_tool, {})
  await executeTool(write_tool, { path: "model.lib", content: regressed_source })
  await executeTool(write_tool, { path: "model-card.md", content: "regressed card\n" })
  const result = (await executeTool(check_tool, {})) as {
    details: { search_control?: { disposition: string } }
  }

  expect(result.details.search_control?.disposition).toBe("retained")
  expect(await readFile(join(workspace, "model.lib"), "utf8")).toBe(first_source)
  expect(await readFile(join(workspace, "model-card.md"), "utf8")).toBe("first card\n")
  expect(
    JSON.parse(await readFile(join(workspace, MODEL_TRAINING_CHECK_RECEIPT_FILE), "utf8")),
  ).toMatchObject({ candidate: { revision: "a".repeat(16) } })
})

test("model candidate check returns bounded diagnostics without leaking its workspace", async () => {
  const workspace = await realpath(await makeTemporaryDirectory("model-tools-workspace-"))
  const [, , check_tool] = createModelCandidateFileTools(workspace, {
    check_candidate: async () => {
      throw new ModelCandidateCheckError(
        "ngspice_smoke_failed",
        `ngspice rejected ${join(workspace, "model.lib")}: syntax error`,
      )
    },
  })

  const result = (await executeTool(check_tool, {})) as {
    content: Array<{ type: string; text?: string }>
    details: { version: number; status: string; code: string; diagnostic: string; retryable: boolean }
  }

  expect(result.details).toEqual({
    version: 1,
    status: "failed",
    code: "ngspice_smoke_failed",
    diagnostic: "ngspice rejected model.lib: syntax error",
    retryable: true,
  })
  expect(result.content[0]?.text).not.toContain(workspace)
})

test("model candidate tool executes the production parser without invoking a simulator", async () => {
  const workspace = await makeTemporaryDirectory("model-tools-real-check-")
  await Promise.all([
    writeFile(
      join(workspace, "model-interface.json"),
      JSON.stringify({
        version: 1,
        part_number: "REAL-CHECK",
        entry_name: "REAL_CHECK",
        pins: [
          {
            physical_pin: "1",
            component_pin: "pin1",
            source_port_id: "source_port_1",
            spice_node: "A",
            labels: ["A"],
            role: "passive",
          },
          {
            physical_pin: "2",
            component_pin: "pin2",
            source_port_id: "source_port_2",
            spice_node: "B",
            labels: ["B"],
            role: "passive",
          },
        ],
      }),
      "utf8",
    ),
    writeFile(join(workspace, "model.lib"), ".SUBCKT REAL_CHECK A B\nR1 A B 1k\n.ENDS REAL_CHECK\n"),
    writeFile(join(workspace, "model-card.md"), "Validated with the public smoke gate.\n"),
  ])
  const [, , check_tool] = createModelCandidateFileTools(workspace, {
    ngspice_path: ngspice_path ?? "ngspice",
  })

  const result = (await executeTool(check_tool, {})) as {
    details: { status: string; checks: string[]; entry_name: string }
  }

  expect(result.details).toMatchObject({
    status: "passed",
    checks: ["model_contract", "model_card", "static_source"],
    entry_name: "REAL_CHECK",
  })
  expect(await Bun.file(join(workspace, ".candidate-smoke", "result.raw")).exists()).toBe(false)
})

test("model candidate tools cannot read outside their workspace or through an escaping symlink", async () => {
  const workspace = await makeTemporaryDirectory("model-tools-workspace-")
  const outside = await makeTemporaryDirectory("model-tools-outside-")
  await writeFile(join(workspace, "model-contract.json"), "inside", "utf8")
  await symlink(join(workspace, "model-contract.json"), join(workspace, "internal-link.json"))
  await writeFile(join(outside, "private-validation-plan.json"), "secret", "utf8")
  await symlink(join(outside, "private-validation-plan.json"), join(workspace, "escaped.json"))
  await link(join(outside, "private-validation-plan.json"), join(workspace, "hard-linked.json"))
  const [read_tool] = createModelCandidateFileTools(workspace)

  const inside_result = (await executeTool(read_tool, { path: "model-contract.json" })) as {
    content: Array<{ type: string; text?: string }>
  }
  expect(inside_result.content[0]?.text).toContain("inside")
  await expect(
    executeTool(read_tool, { path: join(outside, "private-validation-plan.json") }),
  ).rejects.toThrow("only access files")
  await expect(executeTool(read_tool, { path: "escaped.json" })).rejects.toThrow(
    "may not read symbolic links",
  )
  await expect(executeTool(read_tool, { path: "internal-link.json" })).rejects.toThrow(
    "may not read symbolic links",
  )
  await expect(executeTool(read_tool, { path: "hard-linked.json" })).rejects.toThrow("hard-linked files")
})

test("model candidate tools may write only the two declared outputs and never follow output links", async () => {
  const workspace = await makeTemporaryDirectory("model-tools-workspace-")
  const outside = await makeTemporaryDirectory("model-tools-outside-")
  const outside_file = join(outside, "do-not-touch.lib")
  await writeFile(outside_file, "unchanged", "utf8")
  const [, write_tool] = createModelCandidateFileTools(workspace)

  await executeTool(write_tool, { path: "model.lib", content: ".SUBCKT X A B\n.ENDS X\n" })
  expect(await readFile(join(workspace, "model.lib"), "utf8")).toContain(".SUBCKT X")
  await expect(executeTool(write_tool, { path: "model-contract.json", content: "tampered" })).rejects.toThrow(
    "write only model.lib and model-card.md",
  )
  await mkdir(join(workspace, "nested"))
  await expect(executeTool(write_tool, { path: "nested/model-card.md", content: "no" })).rejects.toThrow(
    "Model generation",
  )

  await symlink(outside_file, join(workspace, "model-card.md"))
  await expect(executeTool(write_tool, { path: "model-card.md", content: "tampered" })).rejects.toThrow(
    "regular file",
  )
  expect(await readFile(outside_file, "utf8")).toBe("unchanged")

  await rm(join(workspace, "model-card.md"))
  await link(outside_file, join(workspace, "model-card.md"))
  await expect(executeTool(write_tool, { path: "model-card.md", content: "tampered" })).rejects.toThrow(
    "regular file",
  )
  expect(await readFile(outside_file, "utf8")).toBe("unchanged")
})
