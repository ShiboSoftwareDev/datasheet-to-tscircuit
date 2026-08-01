import { afterEach, expect, test } from "bun:test"
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import type { AgentClient } from "@/server/infrastructure/agent"
import type { ProcessRunner } from "@/server/infrastructure/process"
import { getJobFile } from "@/server/job-api/get-job-file"
import type { JobApiContext } from "@/server/job-api/job-api-context"
import { restoreJobDirectory } from "@/server/job-restorer/restore-job-directory"
import { restoreModelDirectory } from "@/server/job-restorer/restore-model-directory"
import { restorePersistedJobs } from "@/server/job-restorer/restore-persisted-jobs"
import { JobStore } from "@/server/job-store"
import { ModelRunStore } from "@/server/model-run-store"
import { getModelRunFile } from "@/server/model-run-api/get-model-run-file"
import type { ModelRunApiContext } from "@/server/model-run-api/model-run-api-context"
import {
  commitModelPublication,
  createModelManifest,
  ModelStrategyRegistry,
  readModelPublication,
  readVerifiedPublicationArtifact,
  writePublicationBundleManifest,
  writeIntegratedComponent,
  type GeneratedModel,
  type ModelContract,
} from "@/server/modeling"
import {
  commitPreparedModelPublication,
  discardPreparedModelPublication,
  prepareModelPublication,
} from "@/server/model-workflow/stage-helpers"
import { publishModelStage } from "@/server/model-workflow/stages/publish-model"
import {
  hashValidationInputs,
  type ValidationPlan,
  type ValidationRunResult,
} from "@/server/spice-validation"
import { RETAINED_ACCEPTED_WARNING_PREFIX } from "@/shared/model-warnings"

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
    part_number: "PUBLICATION-TEST",
    entry_name: "PUBLICATION_TEST",
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
        requirement_id: "output_voltage",
        title: "Output voltage",
        behavior: "The output is one volt",
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
  model: { entry_name: "PUBLICATION_TEST", pins: ["OUT"] },
  cases: [
    {
      id: "output_voltage",
      requirement_ids: ["output_voltage"],
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
          id: "output",
          requirement_id: "output_voltage",
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

function generatedModel(volts: number): GeneratedModel {
  const source = `.SUBCKT PUBLICATION_TEST OUT\nV_OUTPUT OUT 0 ${volts}\n.ENDS PUBLICATION_TEST\n`
  return {
    source,
    card: `# Publication test\n\nOutput: ${volts} V.\n`,
    manifest: createModelManifest({
      model_interface: contract.interface,
      model_source: source,
      simulator: "ngspice",
    }),
  }
}

function passingResult(generated: GeneratedModel): ValidationRunResult {
  return {
    version: 1,
    passed: true,
    hashes: hashValidationInputs({ plan, model_source: generated.source, manifest: generated.manifest }),
    cases: [
      {
        case_id: "output_voltage",
        status: "passed",
        analysis: "operating_point",
        series: [
          {
            observation_id: "output",
            type: "voltage",
            unit: "V",
            scale: "linear",
            points: [{ x: 0, y: 1 }],
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
}

function componentCircuit(model_source: string, source_port_id = "source_port_1"): AnyCircuitElement[] {
  return [
    { type: "source_component", source_component_id: "source_component_1", name: "U1" },
    {
      type: "source_port",
      source_port_id: "source_port_1",
      source_component_id: "source_component_1",
      pin_number: "1",
      name: "OUT",
      port_hints: ["pin1", "OUT"],
    },
    {
      type: "simulation_spice_subcircuit",
      simulation_spice_subcircuit_id: "simulation_model",
      source_component_id: "source_component_1",
      spice_pin_to_source_port_map: { OUT: source_port_id },
      subcircuit_source: model_source,
    },
  ] as unknown as AnyCircuitElement[]
}

async function createWorkspace(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporary_directories.push(root)
  const job_dir = join(root, "job")
  const model_dir = join(job_dir, "spice")
  const evidence_dir = join(model_dir, "attempt-evidence")
  await Promise.all([mkdir(evidence_dir, { recursive: true }), mkdir(job_dir, { recursive: true })])
  const original_component = 'export default function Original() { return <chip name="U1" /> }\n'
  const original_circuit = [
    { type: "source_component", source_component_id: "source_component_1", name: "U1" },
    {
      type: "source_port",
      source_port_id: "source_port_1",
      source_component_id: "source_component_1",
      pin_number: "1",
      name: "OUT",
      port_hints: ["pin1", "OUT"],
    },
  ] as unknown as AnyCircuitElement[]
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.4\n"),
    Bun.write(join(job_dir, "index.circuit.tsx"), original_component),
    Bun.write(join(job_dir, "component.circuit.tsx"), original_component),
    Bun.write(join(job_dir, "component.circuit.json"), JSON.stringify(original_circuit)),
    Bun.write(join(model_dir, "component.circuit.tsx"), original_component),
    Bun.write(join(model_dir, "component.circuit.json"), JSON.stringify(original_circuit)),
    Bun.write(join(model_dir, "model-interface.json"), JSON.stringify(contract.interface)),
  ])
  return { root, job_dir, model_dir, evidence_dir, original_component, original_circuit }
}

async function createPreparedPublication(input: {
  job_dir: string
  model_dir: string
  evidence_dir: string
  model_run_id: string
  invocation_id: string
  generated: GeneratedModel
  result?: ValidationRunResult
}) {
  const wrapper_dir = join(input.model_dir, "wrapper-stage")
  await mkdir(wrapper_dir, { recursive: true })
  const wrapper_source = await writeIntegratedComponent({
    model_dir: wrapper_dir,
    manifest: input.generated.manifest,
    model_source: input.generated.source,
  })
  const circuit_json = componentCircuit(input.generated.source)
  const job_id = input.model_run_id.replace(/^model_/, "job_")
  return prepareModelPublication({
    job_id,
    job_dir: input.job_dir,
    model_dir: input.model_dir,
    model_run_id: input.model_run_id,
    invocation_id: input.invocation_id,
    contract,
    plan,
    result: input.result ?? passingResult(input.generated),
    generated: input.generated,
    evidence_dir: input.evidence_dir,
    wrapper_source,
    circuit_json,
  })
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

test("publication preparation rejects a forged passing result with a truncated case list", async () => {
  const workspace = await createWorkspace("model-publication-truncated-cases-")
  const accepted = generatedModel(1)

  await expect(
    createPreparedPublication({
      ...workspace,
      model_run_id: "model_truncated_cases",
      invocation_id: crypto.randomUUID(),
      generated: accepted,
      result: { ...passingResult(accepted), cases: [] },
    }),
  ).rejects.toThrow(/cases has 0 cases; the current plan has 1/)

  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
  expect(await Bun.file(join(workspace.model_dir, "accepted-revisions")).exists()).toBe(false)
})

test("publication preparation rejects a passing flag over non-finite simulator points", async () => {
  const workspace = await createWorkspace("model-publication-non-finite-points-")
  const accepted = generatedModel(1)
  const forged = passingResult(accepted)
  forged.cases[0]!.series[0]!.points[0]!.y = Number.POSITIVE_INFINITY

  await expect(
    createPreparedPublication({
      ...workspace,
      model_run_id: "model_non_finite_points",
      invocation_id: crypto.randomUUID(),
      generated: accepted,
      result: forged,
    }),
  ).rejects.toThrow(/points\[0\]\.y must be a finite number/)

  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
})

test("publication preparation rolls back a sibling bundle after a partial promotion failure", async () => {
  const workspace = await createWorkspace("model-publication-partial-promotion-")
  await Bun.write(join(workspace.job_dir, "published-models"), "blocks the destination directory\n")

  await expect(
    createPreparedPublication({
      ...workspace,
      model_run_id: "model_partial_promotion",
      invocation_id: crypto.randomUUID(),
      generated: generatedModel(1),
    }),
  ).rejects.toThrow(/materialize both immutable bundles/)

  const accepted_revisions = await readdir(join(workspace.model_dir, "accepted-revisions")).catch(() => [])
  expect(accepted_revisions).toEqual([])
  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
})

test("a committed pointer recovers one authoritative pair before store and root mirrors catch up", async () => {
  const workspace = await createWorkspace("model-publication-crash-")
  const job_store = new JobStore()
  const model_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_publication", job_dir: workspace.job_dir, file_name: "part.pdf" })
  job_store.updateJob("job_publication", {
    display_status: "complete",
    is_complete: true,
    component_ready: true,
    component_code: workspace.original_component,
    circuit_json: workspace.original_circuit,
  })
  model_store.createModelRun({
    model_run_id: "model_publication",
    job_id: "job_publication",
    model_dir: workspace.model_dir,
    effort_multiplier: 1,
  })
  const old = generatedModel(0.5)
  const invocation_id = crypto.randomUUID()
  model_store.updateModelRun("model_publication", {
    status: "validating",
    is_complete: false,
    current_invocation_id: invocation_id,
    model_source: old.source,
    model_card: old.card,
    manifest: old.manifest,
  })
  await Promise.all([
    Bun.write(join(workspace.model_dir, "model.lib"), old.source),
    Bun.write(join(workspace.model_dir, "model-card.md"), old.card),
    Bun.write(join(workspace.job_dir, "model.lib"), old.source),
  ])
  const accepted = generatedModel(1)
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_publication",
    invocation_id,
    generated: accepted,
  })

  // Simulate power loss at the exact commit barrier: immutable snapshots and
  // pointer are durable, but live stores and root compatibility files are old.
  commitModelPublication(workspace.job_dir, prepared.commit.job_id, prepared.commit)

  expect(await readFile(join(workspace.model_dir, "model.lib"), "utf8")).toBe(old.source)
  expect(await readFile(join(workspace.job_dir, "index.circuit.tsx"), "utf8")).toBe(
    workspace.original_component,
  )

  const restored_models = new ModelRunStore()
  const restored_model = await restoreModelDirectory({
    job_id: "job_publication",
    model_dir: workspace.model_dir,
    model_run_store: restored_models,
  })
  expect(restored_model).toMatchObject({
    status: "complete",
    is_complete: true,
    has_errors: false,
    current_invocation_id: invocation_id,
    model_source: accepted.source,
    model_card: accepted.card,
    manifest: { revision: accepted.manifest.revision },
    validation: { all_passed: true },
  })

  const restored_jobs = new JobStore()
  const restored_job = await restoreJobDirectory({
    job_id: "job_publication",
    job_dir: workspace.job_dir,
    job_store: restored_jobs,
  })
  expect(restored_job?.component_code).toContain("<spicemodel")
  expect(
    restored_job?.circuit_json?.find(({ type }) => type === "simulation_spice_subcircuit"),
  ).toMatchObject({ subcircuit_source: accepted.source })

  // A post-pointer debug/event write can checkpoint the same invocation as
  // failed. The committed invocation remains the authoritative outcome.
  model_store.updateModelRun("model_publication", {
    status: "failed",
    is_complete: true,
    has_errors: true,
    error_message: "post-commit bookkeeping failed",
    current_invocation_id: invocation_id,
  })
  const failed_checkpoint_models = new ModelRunStore()
  const recovered_failed_checkpoint = await restoreModelDirectory({
    job_id: "job_publication",
    model_dir: workspace.model_dir,
    model_run_store: failed_checkpoint_models,
  })
  expect(recovered_failed_checkpoint).toMatchObject({
    status: "complete",
    is_complete: true,
    has_errors: false,
    current_invocation_id: invocation_id,
    model_source: accepted.source,
  })
  expect(recovered_failed_checkpoint?.error_message).toBeUndefined()

  // A later invocation must retain this accepted pair without being mistaken
  // for the invocation that crossed the commit barrier.
  const newer_invocation_id = crypto.randomUUID()
  model_store.updateModelRun("model_publication", {
    status: "validating",
    is_complete: false,
    current_invocation_id: newer_invocation_id,
  })
  const retried_models = new ModelRunStore()
  const retained = await restoreModelDirectory({
    job_id: "job_publication",
    model_dir: workspace.model_dir,
    model_run_store: retried_models,
  })
  expect(retained).toMatchObject({
    status: "failed",
    is_complete: true,
    has_errors: true,
    model_source: accepted.source,
  })
  expect(retained?.warnings?.some((warning) => warning.startsWith(RETAINED_ACCEPTED_WARNING_PREFIX))).toBe(
    true,
  )
  expect(retained?.validation).toBeUndefined()
  expect(retained?.circuit_preview).toBeUndefined()
  expect(retained?.reference_preview).toBeUndefined()
  expect(retained?.preview_options).toEqual([])

  // A compatibility checkpoint cannot promote a newer invocation merely by
  // claiming completion; only the pointer-owning invocation crossed commit.
  model_store.updateModelRun("model_publication", {
    status: "complete",
    is_complete: true,
    has_errors: false,
    current_invocation_id: newer_invocation_id,
  })
  const uncommitted_completion = await restoreModelDirectory({
    job_id: "job_publication",
    model_dir: workspace.model_dir,
    model_run_store: new ModelRunStore(),
  })
  expect(uncommitted_completion).toMatchObject({
    status: "failed",
    is_complete: true,
    has_errors: true,
    current_invocation_id: newer_invocation_id,
    model_source: accepted.source,
    validation: undefined,
  })
  expect(uncommitted_completion?.error_message).toMatch(/claimed completion without committing/)
})

test("a valid publication cannot replace its owning job marker but recovers a missing model checkpoint", async () => {
  const workspace = await createWorkspace("model-publication-checkpoint-loss-")
  const accepted = generatedModel(1)
  const invocation_id = crypto.randomUUID()
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_checkpoint_loss",
    invocation_id,
    generated: accepted,
  })
  commitModelPublication(workspace.job_dir, prepared.commit.job_id, prepared.commit)

  await expect(
    restoreJobDirectory({
      job_id: "job_checkpoint_loss",
      job_dir: workspace.job_dir,
      job_store: new JobStore(),
    }),
  ).rejects.toMatchObject({
    name: "JobRestoreMarkerError",
    code: "job_marker_missing_with_publication",
  })

  const restored_without_checkpoint = await restoreModelDirectory({
    job_id: "job_checkpoint_loss",
    model_dir: workspace.model_dir,
    model_run_store: new ModelRunStore(),
  })
  expect(restored_without_checkpoint).toMatchObject({
    model_run_id: "model_checkpoint_loss",
    job_id: "job_checkpoint_loss",
    status: "complete",
    is_complete: true,
    has_errors: false,
    current_invocation_id: invocation_id,
    model_source: accepted.source,
  })

  await Bun.write(join(workspace.model_dir, "model-run.json"), "{not json")
  const restored_with_corrupt_checkpoint = await restoreModelDirectory({
    job_id: "job_checkpoint_loss",
    model_dir: workspace.model_dir,
    model_run_store: new ModelRunStore(),
  })
  expect(restored_with_corrupt_checkpoint).toMatchObject({
    model_run_id: "model_checkpoint_loss",
    status: "complete",
    has_errors: false,
    current_invocation_id: invocation_id,
    model_source: accepted.source,
  })

  for (const current_invocation_id of [undefined, "invalid invocation id"]) {
    await Bun.write(
      join(workspace.model_dir, "model-run.json"),
      JSON.stringify({
        model_run_id: "model_checkpoint_loss",
        job_id: "job_checkpoint_loss",
        status: "failed",
        is_complete: true,
        has_errors: true,
        ...(current_invocation_id === undefined ? {} : { current_invocation_id }),
      }),
    )
    const restored_without_newer_identity = await restoreModelDirectory({
      job_id: "job_checkpoint_loss",
      model_dir: workspace.model_dir,
      model_run_store: new ModelRunStore(),
    })
    expect(restored_without_newer_identity).toMatchObject({
      model_run_id: "model_checkpoint_loss",
      status: "complete",
      is_complete: true,
      has_errors: false,
      current_invocation_id: invocation_id,
      model_source: accepted.source,
    })
  }

  await Bun.write(
    join(workspace.model_dir, "model-run.json"),
    JSON.stringify({
      model_run_id: "different_model_run",
      job_id: "job_checkpoint_loss",
      status: "failed",
      current_invocation_id: crypto.randomUUID(),
    }),
  )
  const restored_with_conflicting_checkpoint = await restoreModelDirectory({
    job_id: "job_checkpoint_loss",
    model_dir: workspace.model_dir,
    model_run_store: new ModelRunStore(),
  })
  expect(restored_with_conflicting_checkpoint).toMatchObject({
    model_run_id: "model_checkpoint_loss",
    status: "complete",
    has_errors: false,
    current_invocation_id: invocation_id,
    model_source: accepted.source,
  })
  expect(restored_with_conflicting_checkpoint?.warnings).toContain(
    "Ignored a conflicting model-run checkpoint and recovered the hash-verified accepted publication.",
  )
})

test("a failed integrated build cannot replace the prior accepted root files or state", async () => {
  const workspace = await createWorkspace("model-publication-integration-failure-")
  const job_store = new JobStore()
  const model_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_integration", job_dir: workspace.job_dir, file_name: "part.pdf" })
  job_store.updateJob("job_integration", {
    display_status: "complete",
    is_complete: true,
    component_ready: true,
    component_code: workspace.original_component,
    circuit_json: workspace.original_circuit,
  })
  model_store.createModelRun({
    model_run_id: "model_integration",
    job_id: "job_integration",
    model_dir: workspace.model_dir,
    effort_multiplier: 1,
  })
  const old = generatedModel(0.5)
  model_store.updateModelRun("model_integration", {
    status: "complete",
    is_complete: true,
    model_source: old.source,
    model_card: old.card,
    manifest: old.manifest,
  })
  await Promise.all([
    Bun.write(join(workspace.model_dir, "model.lib"), old.source),
    Bun.write(join(workspace.model_dir, "model-card.md"), old.card),
    Bun.write(join(workspace.model_dir, "model-manifest.json"), JSON.stringify(old.manifest)),
    Bun.write(join(workspace.job_dir, "model.lib"), old.source),
  ])

  const candidate = generatedModel(1)
  const candidate_dir = join(workspace.model_dir, "candidates", "candidate")
  const attempt_dir = join(workspace.model_dir, "attempts", "candidate")
  const validation_dir = join(candidate_dir, "validation")
  await Promise.all([
    mkdir(validation_dir, { recursive: true }),
    mkdir(attempt_dir, { recursive: true }),
    Bun.write(join(candidate_dir, "model.lib"), candidate.source),
    Bun.write(join(candidate_dir, "model-card.md"), candidate.card),
    Bun.write(join(candidate_dir, "model-manifest.json"), JSON.stringify(candidate.manifest)),
    Bun.write(join(attempt_dir, "model-contract.json"), JSON.stringify(contract)),
    Bun.write(join(attempt_dir, "validation-plan.json"), JSON.stringify(plan)),
    Bun.write(join(validation_dir, "validation-results.json"), JSON.stringify(passingResult(candidate))),
  ])

  const process_runner: ProcessRunner = {
    async run(request) {
      const wrapper_source = await readFile(join(request.cwd, "component-with-model.circuit.tsx"), "utf8")
      const encoded_source = /^const modelSource = (.+)$/m.exec(wrapper_source)?.[1]
      if (!encoded_source) throw new Error("Missing wrapper model source")
      const source = JSON.parse(encoded_source) as string
      const output_dir = join(request.cwd, "dist", "component-with-model")
      await mkdir(output_dir, { recursive: true })
      await Bun.write(
        join(output_dir, "circuit.json"),
        JSON.stringify(componentCircuit(source, "wrong_source_port")),
      )
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    },
  }
  const unused_agent: AgentClient = {
    async run() {
      throw new Error("Agent must not run during publication")
    },
  }

  await expect(
    publishModelStage.execute({
      run_id: "model_integration",
      pipeline_id: "datasheet_model",
      stage_id: "publish_model",
      debug_dir: join(workspace.model_dir, "debug"),
      context: {
        model_run_id: "model_integration",
        job_id: "job_integration",
        job_dir: workspace.job_dir,
        model_dir: workspace.model_dir,
        use_openai: false,
        max_repair_attempts: 1,
        invocation_id: crypto.randomUUID(),
      },
      services: {
        job_store,
        model_run_store: model_store,
        agent_client: unused_agent,
        process_runner,
        strategy_registry: new ModelStrategyRegistry(),
        tsci_bin: "fixture-tsci",
        ngspice_bin: "unused-ngspice",
        ngspice_executor: async () => {
          throw new Error("ngspice must not run during publication")
        },
      },
      dependency_outputs: {
        repair_model: {
          result_path: join(validation_dir, "validation-results.json"),
          model_path: join(candidate_dir, "model.lib"),
          model_card_path: join(candidate_dir, "model-card.md"),
          manifest_path: join(candidate_dir, "model-manifest.json"),
          contract_path: join(attempt_dir, "model-contract.json"),
          plan_path: join(attempt_dir, "validation-plan.json"),
          evidence_dir: workspace.evidence_dir,
          passed: true,
          repair_attempts: 0,
          revision: candidate.manifest.revision,
        },
      },
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/pin mapping/)

  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
  expect(await readFile(join(workspace.model_dir, "model.lib"), "utf8")).toBe(old.source)
  expect(await readFile(join(workspace.model_dir, "model-card.md"), "utf8")).toBe(old.card)
  expect(await readFile(join(workspace.job_dir, "index.circuit.tsx"), "utf8")).toBe(
    workspace.original_component,
  )
  expect(await readFile(join(workspace.job_dir, "model.lib"), "utf8")).toBe(old.source)
  expect(model_store.getModelRun("model_integration")).toMatchObject({
    model_source: old.source,
    model_card: old.card,
    manifest: { revision: old.manifest.revision },
  })
})

test("a committed bundle rejects tampering before readers select it", async () => {
  const workspace = await createWorkspace("model-publication-tamper-")
  const accepted = generatedModel(1)
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_tamper",
    invocation_id: crypto.randomUUID(),
    generated: accepted,
  })
  commitModelPublication(workspace.job_dir, prepared.commit.job_id, prepared.commit)
  await Bun.write(join(prepared.accepted_model_dir, "model-card.md"), "tampered\n")

  await expect(readModelPublication(workspace.job_dir, prepared.commit.job_id)).rejects.toThrow(
    /bundle contents/,
  )
})

test("publication identity is bound into both immutable bundles", async () => {
  const workspace = await createWorkspace("model-publication-identity-")
  const accepted = generatedModel(1)
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_identity",
    invocation_id: crypto.randomUUID(),
    generated: accepted,
  })
  commitModelPublication(workspace.job_dir, prepared.commit.job_id, prepared.commit)
  const pointer_path = join(workspace.job_dir, "published-model.json")
  const changed_pointer = {
    ...JSON.parse(await readFile(pointer_path, "utf8")),
    invocation_id: crypto.randomUUID(),
  }
  await Bun.write(pointer_path, JSON.stringify(changed_pointer))

  await expect(readModelPublication(workspace.job_dir, prepared.commit.job_id)).rejects.toThrow(
    /metadata does not match/,
  )
})

test("matching bundle hashes cannot bless a non-server-owned wrapper", async () => {
  const workspace = await createWorkspace("model-publication-wrapper-identity-")
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_wrapper_identity",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  const replacement = 'export default function Unrelated() { return <chip name="WRONG" /> }\n'
  await Promise.all([
    Bun.write(join(prepared.accepted_model_dir, "component-with-model.circuit.tsx"), replacement),
    Bun.write(join(prepared.published_component_dir, "index.circuit.tsx"), replacement),
  ])
  const [accepted_bundle_manifest_sha256, published_component_bundle_manifest_sha256] = await Promise.all([
    writePublicationBundleManifest(prepared.accepted_model_dir),
    writePublicationBundleManifest(prepared.published_component_dir),
  ])
  commitModelPublication(workspace.job_dir, prepared.commit.job_id, {
    ...prepared.commit,
    accepted_bundle_manifest_sha256,
    published_component_bundle_manifest_sha256,
  })

  await expect(readModelPublication(workspace.job_dir, prepared.commit.job_id)).rejects.toThrow(
    /server-owned model integration/,
  )
})

test("publication readers reject pointer and ancestor symlinks", async () => {
  const pointer_workspace = await createWorkspace("model-publication-pointer-symlink-")
  const pointer_prepared = await createPreparedPublication({
    ...pointer_workspace,
    model_run_id: "model_pointer_symlink",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  commitModelPublication(pointer_workspace.job_dir, pointer_prepared.commit.job_id, pointer_prepared.commit)
  const pointer_path = join(pointer_workspace.job_dir, "published-model.json")
  const pointer_target = join(pointer_workspace.root, "pointer-target.json")
  await rename(pointer_path, pointer_target)
  await symlink(pointer_target, pointer_path)
  await expect(
    readModelPublication(pointer_workspace.job_dir, pointer_prepared.commit.job_id),
  ).rejects.toThrow(/not a symlink/)

  const ancestor_workspace = await createWorkspace("model-publication-ancestor-symlink-")
  const ancestor_prepared = await createPreparedPublication({
    ...ancestor_workspace,
    model_run_id: "model_ancestor_symlink",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  commitModelPublication(
    ancestor_workspace.job_dir,
    ancestor_prepared.commit.job_id,
    ancestor_prepared.commit,
  )
  const accepted_parent = join(ancestor_workspace.model_dir, "accepted-revisions")
  const escaped_parent = join(ancestor_workspace.root, "escaped-accepted-revisions")
  await rename(accepted_parent, escaped_parent)
  await symlink(escaped_parent, accepted_parent)
  await expect(
    readModelPublication(ancestor_workspace.job_dir, ancestor_prepared.commit.job_id),
  ).rejects.toThrow(/outside the job workspace/)
})

test("verified artifact reads reject ancestor and final-path swaps after publication validation", async () => {
  const workspace = await createWorkspace("model-publication-read-swap-")
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_read_swap",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  commitModelPublication(workspace.job_dir, prepared.commit.job_id, prepared.commit)
  const publication = await readModelPublication(workspace.job_dir, prepared.commit.job_id)
  if (!publication) throw new Error("publication fixture was not committed")

  const original_source = await readFile(join(prepared.accepted_model_dir, "model.lib"), "utf8")
  const attacker_dir = join(workspace.root, "attacker-accepted")
  const attacker_source = join(attacker_dir, "model.lib")
  const saved_accepted_dir = join(workspace.root, "saved-accepted")
  await mkdir(attacker_dir, { recursive: true })
  await Bun.write(attacker_source, "S".repeat(Buffer.byteLength(original_source)))
  await rename(prepared.accepted_model_dir, saved_accepted_dir)
  await symlink(attacker_dir, prepared.accepted_model_dir)

  await expect(
    readVerifiedPublicationArtifact({
      publication,
      bundle: "accepted_model",
      relative_path: "model.lib",
      max_bytes: 2 * 1024 * 1024,
    }),
  ).rejects.toThrow(/changed after publication validation/)

  await unlink(prepared.accepted_model_dir)
  await rename(saved_accepted_dir, prepared.accepted_model_dir)
  const model_path = join(prepared.accepted_model_dir, "model.lib")
  await rename(model_path, `${model_path}.saved`)
  await symlink(attacker_source, model_path)
  await expect(
    readVerifiedPublicationArtifact({
      publication,
      bundle: "accepted_model",
      relative_path: "model.lib",
      max_bytes: 2 * 1024 * 1024,
    }),
  ).rejects.toThrow(/not a symlink/)
})

test("publication downloads buffer verified bytes before response bodies are consumed", async () => {
  const workspace = await createWorkspace("model-publication-buffered-download-")
  const job_id = "job_buffered_download"
  const model_run_id = "model_buffered_download"
  const job_store = new JobStore()
  const model_store = new ModelRunStore()
  job_store.createJob({ job_id, job_dir: workspace.job_dir, file_name: "part.pdf" })
  model_store.createModelRun({
    model_run_id,
    job_id,
    model_dir: workspace.model_dir,
    effort_multiplier: 1,
  })
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id,
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  commitModelPublication(workspace.job_dir, job_id, prepared.commit)

  const model_response = await getModelRunFile(
    new URL(`http://localhost/api/model-run/file?job_id=${job_id}&file=model`),
    { model_run_store: model_store } as unknown as ModelRunApiContext,
  )
  const component_response = await getJobFile(
    new URL(`http://localhost/api/job/file?job_id=${job_id}&file=component`),
    { job_store } as unknown as JobApiContext,
  )
  expect(model_response.status).toBe(200)
  expect(component_response.status).toBe(200)

  const model_path = join(prepared.accepted_model_dir, "model.lib")
  const component_path = join(prepared.published_component_dir, "index.circuit.tsx")
  const original_model = await readFile(model_path, "utf8")
  const original_component = await readFile(component_path, "utf8")
  await Promise.all([
    Bun.write(model_path, "M".repeat(Buffer.byteLength(original_model))),
    Bun.write(component_path, "C".repeat(Buffer.byteLength(original_component))),
  ])

  expect(await model_response.text()).toBe(original_model)
  expect(await component_response.text()).toBe(original_component)
})

test("a copied publication cannot cross-wire another job or duplicate its model id on restart", async () => {
  const source = await createWorkspace("model-publication-owner-")
  const owner_job_id = "job_owner"
  const prepared = await createPreparedPublication({
    ...source,
    model_run_id: "model_owner",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  const source_job_store = new JobStore()
  source_job_store.createJob({
    job_id: owner_job_id,
    job_dir: source.job_dir,
    file_name: "owner.pdf",
  })
  commitModelPublication(source.job_dir, owner_job_id, prepared.commit)

  const jobs_root = await mkdtemp(join(tmpdir(), "model-publication-cross-job-"))
  temporary_directories.push(jobs_root)
  const owner_dir = join(jobs_root, owner_job_id)
  const copied_job_id = "job_copy"
  const copied_dir = join(jobs_root, copied_job_id)
  await cp(source.job_dir, owner_dir, { recursive: true })
  await cp(owner_dir, copied_dir, { recursive: true })
  new JobStore().createJob({ job_id: copied_job_id, job_dir: copied_dir, file_name: "copy.pdf" })

  const failures: Array<{ job_id: string; cause: string }> = []
  const restored_jobs = new JobStore()
  const restored_models = new ModelRunStore()
  const result = await restorePersistedJobs({
    jobs_root,
    job_store: restored_jobs,
    model_run_store: restored_models,
    on_restore_error: (failure) => {
      failures.push(failure)
    },
  })

  expect(result).toEqual({ jobs_restored: 2, model_runs_restored: 1 })
  expect(restored_jobs.getJob(owner_job_id)?.component_code).toContain("<spicemodel")
  expect(restored_jobs.getJob(copied_job_id)).toMatchObject({
    has_errors: true,
    error_message: expect.stringContaining("belongs to job"),
    warnings: [expect.stringContaining("Committed model publication failed integrity validation")],
  })
  expect(restored_models.getModelRunForJob(owner_job_id)?.model_run_id).toBe("model_owner")
  expect(restored_models.getModelRunForJob(copied_job_id)).toBeUndefined()
  expect(failures).toEqual([
    expect.objectContaining({ job_id: copied_job_id, cause: expect.stringContaining("belongs to job") }),
  ])
})

test("bundle manifests safely bind a file named __proto__", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-publication-prototype-key-"))
  temporary_directories.push(directory)
  await Bun.write(join(directory, "__proto__"), "bound bytes\n")
  await writePublicationBundleManifest(directory)
  const manifest = JSON.parse(await readFile(join(directory, "bundle-manifest.json"), "utf8"))
  expect(Object.hasOwn(manifest.files, "__proto__")).toBe(true)
  expect(manifest.files.__proto__).toMatchObject({ size_bytes: 12 })
})

test("cancellation is checked again before the publication pointer is committed", async () => {
  const workspace = await createWorkspace("model-publication-cancel-")
  const job_store = new JobStore()
  const model_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_cancel", job_dir: workspace.job_dir, file_name: "part.pdf" })
  model_store.createModelRun({
    model_run_id: "model_cancel",
    job_id: "job_cancel",
    model_dir: workspace.model_dir,
    effort_multiplier: 1,
  })
  const accepted = generatedModel(1)
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_cancel",
    invocation_id: crypto.randomUUID(),
    generated: accepted,
  })
  const controller = new AbortController()
  controller.abort(new Error("cancel before publication"))

  await expect(
    commitPreparedModelPublication({
      prepared,
      job_id: "job_cancel",
      job_dir: workspace.job_dir,
      job_store,
      model_dir: workspace.model_dir,
      model_run_id: "model_cancel",
      model_run_store: model_store,
      plan,
      generated: accepted,
      circuit_json: componentCircuit(accepted.source),
      signal: controller.signal,
    }),
  ).rejects.toThrow("cancel before publication")
  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
  expect(await pathExists(prepared.accepted_model_dir)).toBe(false)
  expect(await pathExists(prepared.published_component_dir)).toBe(false)
})

test("prepared publication cleanup preserves the generation selected by the pointer", async () => {
  const workspace = await createWorkspace("model-publication-selected-cleanup-")
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_selected_cleanup",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  commitModelPublication(workspace.job_dir, prepared.commit.job_id, prepared.commit)

  await discardPreparedModelPublication(prepared)

  expect(await pathExists(prepared.accepted_model_dir)).toBe(true)
  expect(await pathExists(prepared.published_component_dir)).toBe(true)
})

test("the commit barrier rejects a hash-consistent bundle with truncated passing series", async () => {
  const workspace = await createWorkspace("model-publication-truncated-series-")
  const job_store = new JobStore()
  const model_store = new ModelRunStore()
  const invocation_id = crypto.randomUUID()
  job_store.createJob({
    job_id: "job_truncated_series",
    job_dir: workspace.job_dir,
    file_name: "part.pdf",
  })
  model_store.createModelRun({
    model_run_id: "model_truncated_series",
    job_id: "job_truncated_series",
    model_dir: workspace.model_dir,
    effort_multiplier: 1,
  })
  model_store.updateModelRun("model_truncated_series", { current_invocation_id: invocation_id })
  const accepted = generatedModel(1)
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_truncated_series",
    invocation_id,
    generated: accepted,
  })
  const forged = passingResult(accepted)
  forged.cases[0]!.series = []
  await Bun.write(join(prepared.accepted_model_dir, "validation-results.json"), JSON.stringify(forged))
  prepared.commit.accepted_bundle_manifest_sha256 = await writePublicationBundleManifest(
    prepared.accepted_model_dir,
  )

  await expect(
    commitPreparedModelPublication({
      prepared,
      job_id: "job_truncated_series",
      job_dir: workspace.job_dir,
      job_store,
      model_dir: workspace.model_dir,
      model_run_id: "model_truncated_series",
      model_run_store: model_store,
      plan,
      generated: accepted,
      circuit_json: componentCircuit(accepted.source),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/series does not cover every current validation-plan observation/)

  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
  expect(model_store.getModelRun("model_truncated_series")?.model_source).toBeUndefined()
})

test("a stale prepared publication cannot replace the current invocation", async () => {
  const workspace = await createWorkspace("model-publication-stale-")
  const job_store = new JobStore()
  const model_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_stale", job_dir: workspace.job_dir, file_name: "part.pdf" })
  model_store.createModelRun({
    model_run_id: "model_stale",
    job_id: "job_stale",
    model_dir: workspace.model_dir,
    effort_multiplier: 1,
  })
  const prepared_invocation_id = crypto.randomUUID()
  const accepted = generatedModel(1)
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_stale",
    invocation_id: prepared_invocation_id,
    generated: accepted,
  })
  model_store.updateModelRun("model_stale", { current_invocation_id: crypto.randomUUID() })

  await expect(
    commitPreparedModelPublication({
      prepared,
      job_id: "job_stale",
      job_dir: workspace.job_dir,
      job_store,
      model_dir: workspace.model_dir,
      model_run_id: "model_stale",
      model_run_store: model_store,
      plan,
      generated: accepted,
      circuit_json: componentCircuit(accepted.source),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/invocation_id is no longer current/)
  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
  expect(await pathExists(prepared.accepted_model_dir)).toBe(false)
  expect(await pathExists(prepared.published_component_dir)).toBe(false)
})

test("live publication state must match the validated immutable bundle", async () => {
  const workspace = await createWorkspace("model-publication-caller-state-")
  const job_store = new JobStore()
  const model_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_caller_state", job_dir: workspace.job_dir, file_name: "part.pdf" })
  model_store.createModelRun({
    model_run_id: "model_caller_state",
    job_id: "job_caller_state",
    model_dir: workspace.model_dir,
    effort_multiplier: 1,
  })
  const invocation_id = crypto.randomUUID()
  model_store.updateModelRun("model_caller_state", { current_invocation_id: invocation_id })
  const accepted = generatedModel(1)
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_caller_state",
    invocation_id,
    generated: accepted,
  })

  await expect(
    commitPreparedModelPublication({
      prepared,
      job_id: "job_caller_state",
      job_dir: workspace.job_dir,
      job_store,
      model_dir: workspace.model_dir,
      model_run_id: "model_caller_state",
      model_run_store: model_store,
      plan,
      generated: generatedModel(0.5),
      circuit_json: componentCircuit(accepted.source),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/caller state differs.*generated model/)
  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
  expect(model_store.getModelRun("model_caller_state")?.model_source).toBeUndefined()
  expect(await pathExists(prepared.accepted_model_dir)).toBe(false)
  expect(await pathExists(prepared.published_component_dir)).toBe(false)
})
