import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  generateApplicationSource,
  generateComponentSource,
} from "@/server/component-workflow/source-candidates"
import { readApprovedEvidence } from "@/server/component-workflow/stage-helpers"
import type { AgentClient } from "@/server/infrastructure/agent"
import { createJobApiHandler } from "@/server/job-api"
import { restoreJobDirectory } from "@/server/job-restorer/restore-job-directory"
import { JobStore } from "@/server/job-store"
import { prepareReferenceGraphInputs } from "@/server/modeling"
import { publishCommittedEvidenceFixture } from "./fixtures/committed-evidence"

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const text_source = { page: 1, method: "pdf_text", confidence: "high" } as const
const land_pattern_source = {
  page: 2,
  figure: "Recommended land pattern",
  method: "pdf_visual",
  confidence: "high",
  image: "visual-reference/land-pattern.png",
  render_dpi: 200,
} as const
const application_source = {
  page: 3,
  figure: "Typical application",
  method: "pdf_visual",
  confidence: "high",
  image: "visual-reference/typical-application.png",
  render_dpi: 200,
} as const

function componentEvidence() {
  return {
    version: 1,
    status: "resolved",
    part_number: { value: "SOLID-2", sources: [text_source] },
    package: {
      name: { value: "Two-terminal test package", sources: [text_source] },
      pin_count: { value: 2, sources: [text_source] },
    },
    pinout: {
      pins: [
        { number: "1", labels: ["INPUT"], role: "input", sources: [text_source] },
        { number: "2", labels: ["RETURN"], role: "ground", sources: [text_source] },
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
          x: -0.75,
          y: 0,
          width: 0.55,
          height: 0.8,
          sources: [land_pattern_source],
        },
        {
          pin: "2",
          kind: "smt",
          x: 0.75,
          y: 0,
          width: 0.55,
          height: 0.8,
          sources: [land_pattern_source],
        },
      ],
    },
    unresolved_ambiguities: [],
  }
}

function applicationPlan() {
  return {
    version: 4,
    availability: "documented",
    pcb_implementation: "schematic_only",
    title: "Committed reference application",
    description: "The documented application connects a bypass capacitor.",
    source_references: [application_source],
    components: [
      { reference: "U1", kind: "integrated_circuit", value: "SOLID-2" },
      { reference: "C1", kind: "capacitor", value: "100nF" },
    ],
    connections: [
      { net: "INPUT", pins: ["U1.INPUT", "C1.1"] },
      { net: "RETURN", pins: ["U1.RETURN", "C1.2"] },
    ],
  }
}

async function createCommittedJob(): Promise<string> {
  const job_dir = await mkdtemp(join(tmpdir(), "committed-evidence-consumer-"))
  temporary_directories.push(job_dir)
  await publishCommittedEvidenceFixture({
    job_dir,
    component_evidence: componentEvidence(),
    application_plan: applicationPlan(),
  })
  return job_dir
}

async function committedEvidenceDir(job_dir: string): Promise<string> {
  const pointer = (await Bun.file(join(job_dir, "evidence-commit.json")).json()) as {
    version?: number
    evidence_directory?: string
  }
  if (pointer.version !== 3 || typeof pointer.evidence_directory !== "string") {
    throw new Error("Expected a version-3 evidence pointer")
  }
  return join(job_dir, pointer.evidence_directory)
}

async function writeProjectFiles(job_dir: string): Promise<void> {
  await Promise.all([
    Bun.write(join(job_dir, "package.json"), "{}\n"),
    Bun.write(join(job_dir, "tsconfig.json"), "{}\n"),
    Bun.write(join(job_dir, "tscircuit.config.json"), "{}\n"),
    Bun.write(join(job_dir, "tscircuit.config.ts"), "export default {}\n"),
  ])
}

test("component correction attempts reuse one committed in-memory evidence snapshot", async () => {
  const job_dir = await createCommittedJob()
  const evidence_dir = await committedEvidenceDir(job_dir)
  await writeProjectFiles(job_dir)
  const observed_part_numbers: string[] = []
  const agent_client: AgentClient = {
    async run(input) {
      const evidence = (await Bun.file(join(input.workspace, "component-evidence.json")).json()) as {
        part_number: { value: string }
      }
      observed_part_numbers.push(evidence.part_number.value)
      expect(await Bun.file(join(input.workspace, "visual-reference", "land-pattern.png")).exists()).toBe(
        true,
      )
      if (observed_part_numbers.length === 1) {
        const mutable_evidence = (await Bun.file(join(evidence_dir, "component-evidence.json")).json()) as {
          part_number: { value: string }
        }
        mutable_evidence.part_number.value = "MUTATED-AFTER-SNAPSHOT"
        await Bun.write(
          join(evidence_dir, "component-evidence.json"),
          `${JSON.stringify(mutable_evidence, null, 2)}\n`,
        )
        await Bun.write(join(input.workspace, "index.circuit.tsx"), "const invalid = true\n")
      } else {
        await Bun.write(
          join(input.workspace, "index.circuit.tsx"),
          'export default () => <chip name="U1" />\n',
        )
      }
      return { attempts: 1, duration_ms: 1, output_tail: "" }
    },
  }

  const result = await generateComponentSource({
    job_dir,
    signal: new AbortController().signal,
    use_openai: false,
    agent_client,
    debug_dir: join(job_dir, "debug", "component"),
    on_output() {},
  })

  expect(result.attempts).toBe(2)
  expect(observed_part_numbers).toEqual(["SOLID-2", "SOLID-2"])
  expect(await Bun.file(join(job_dir, "index.circuit.tsx")).text()).toContain("export default")
  await expect(readApprovedEvidence(job_dir)).rejects.toThrow(
    "Committed evidence integrity check failed for component-evidence.json",
  )
})

test("application generation rejects a plan outside its committed snapshot", async () => {
  const job_dir = await createCommittedJob()
  const { application_plan } = await readApprovedEvidence(job_dir)
  let agent_called = false
  const agent_client: AgentClient = {
    async run() {
      agent_called = true
      return { attempts: 1, duration_ms: 1, output_tail: "" }
    },
  }

  await expect(
    generateApplicationSource({
      job_dir,
      plan: { ...application_plan, title: "Stale caller plan" },
      signal: new AbortController().signal,
      use_openai: false,
      agent_client,
      debug_dir: join(job_dir, "debug", "application"),
      on_output() {},
    }),
  ).rejects.toThrow("Application source plan does not match the committed evidence snapshot")
  expect(agent_called).toBe(false)
})

test("reference graph inputs materialize committed evidence and fail closed on tampering", async () => {
  const job_dir = await createCommittedJob()
  const evidence_dir = await committedEvidenceDir(job_dir)
  const model_dir = join(job_dir, "spice")

  const { model_interface } = await prepareReferenceGraphInputs({
    job_dir,
    model_dir,
    invocation_id: "initial",
  })
  expect(model_interface.part_number).toBe("SOLID-2")
  expect(await Bun.file(join(model_dir, "component-evidence.json")).text()).toBe(
    await Bun.file(join(evidence_dir, "component-evidence.json")).text(),
  )
  expect(await Bun.file(join(model_dir, "typical-application-plan.json")).text()).toBe(
    await Bun.file(join(evidence_dir, "typical-application-plan.json")).text(),
  )
  expect(await Bun.file(join(model_dir, "datasheet.pdf")).text()).toBe(
    await Bun.file(join(job_dir, "datasheet.pdf")).text(),
  )
  expect(await Bun.file(join(model_dir, "component.circuit.tsx")).exists()).toBe(false)
  expect(await Bun.file(join(model_dir, "component.circuit.json")).exists()).toBe(false)

  const mutable_plan = (await Bun.file(join(evidence_dir, "typical-application-plan.json")).json()) as {
    title: string
  }
  mutable_plan.title = "Uncommitted title"
  await Bun.write(
    join(evidence_dir, "typical-application-plan.json"),
    `${JSON.stringify(mutable_plan, null, 2)}\n`,
  )
  const rejected_model_dir = join(job_dir, "spice-after-tamper")
  await expect(
    prepareReferenceGraphInputs({
      job_dir,
      model_dir: rejected_model_dir,
      invocation_id: "tampered",
    }),
  ).rejects.toThrow("Committed evidence integrity check failed for typical-application-plan.json")
  expect(await Bun.file(rejected_model_dir).exists()).toBe(false)
})

test("reference graph inputs reject legacy evidence that does not bind a source PDF", async () => {
  const job_dir = await createCommittedJob()
  const relative_paths = [
    "component-evidence.json",
    "footprint-plan.json",
    "component-schematic-plan.json",
    "typical-application-plan.json",
    "visual-reference/land-pattern.png",
    "visual-reference/source-page-2.png",
    "visual-reference/source-page-3.png",
    "visual-reference/typical-application.png",
  ]
  const files: Record<string, { sha256: string; size_bytes: number }> = {}
  for (const relative_path of relative_paths) {
    const bytes = new Uint8Array(await Bun.file(join(job_dir, relative_path)).arrayBuffer())
    files[relative_path] = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.byteLength,
    }
  }
  await Bun.write(
    join(job_dir, "evidence-commit.json"),
    `${JSON.stringify({ version: 1, committed_at: new Date().toISOString(), files }, null, 2)}\n`,
  )

  const model_dir = join(job_dir, "spice-legacy-evidence")
  await expect(prepareReferenceGraphInputs({ job_dir, model_dir, invocation_id: "legacy" })).rejects.toThrow(
    "requires PDF-bound evidence version 2 or newer",
  )
  expect(await Bun.file(model_dir).exists()).toBe(false)
})

test("job restoration uses a v3 snapshot when the mutable root PDF is missing", async () => {
  const job_dir = await createCommittedJob()
  const original_store = new JobStore()
  original_store.createJob({
    job_id: "restore-committed-title",
    job_dir,
    file_name: "fixture.pdf",
  })
  original_store.updateJob("restore-committed-title", {
    typical_application_title: "Stale checkpoint title",
  })
  await rm(join(job_dir, "datasheet.pdf"))

  const restored = await restoreJobDirectory({
    job_id: "restore-committed-title",
    job_dir,
    job_store: new JobStore(),
  })

  expect(restored?.evidence_available).toBe(true)
  expect(restored?.typical_application_title).toBe("Committed reference application")
})

test("retry copies the exact v3 source PDF after the mutable root is changed or removed", async () => {
  const committed_datasheet = "%PDF-1.7\nimmutable retry source\n"

  for (const root_state of ["changed", "removed"] as const) {
    const jobs_root = await mkdtemp(join(tmpdir(), `committed-retry-${root_state}-`))
    temporary_directories.push(jobs_root)
    const source_job_id = `source-${root_state}`
    const source_dir = join(jobs_root, source_job_id)
    await mkdir(source_dir)
    await publishCommittedEvidenceFixture({
      job_dir: source_dir,
      datasheet: committed_datasheet,
      component_evidence: componentEvidence(),
      application_plan: applicationPlan(),
    })

    const job_store = new JobStore()
    job_store.createJob({
      job_id: source_job_id,
      job_dir: source_dir,
      file_name: "fixture.pdf",
    })
    job_store.updateJob(source_job_id, {
      display_status: "failed",
      is_complete: true,
      has_errors: true,
    })
    if (root_state === "changed") {
      await Bun.write(join(source_dir, "datasheet.pdf"), "%PDF-1.7\nmutable replacement\n")
    } else {
      await rm(join(source_dir, "datasheet.pdf"))
    }

    const handle = createJobApiHandler({
      jobs_root,
      job_store,
      agent_bin: "unused-agent",
      tsci_bin: "unused-tsci",
      run_job: async () => undefined,
    })
    const response = await handle(
      new Request(`http://localhost/api/job/retry?job_id=${source_job_id}`, { method: "POST" }),
    )
    const body = (await response?.json()) as { job: { job_id: string } }

    expect(response?.status).toBe(202)
    expect(await Bun.file(join(jobs_root, body.job.job_id, "datasheet.pdf")).text()).toBe(committed_datasheet)
  }
})

test("job restoration keeps an unavailable committed application out of the UI", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "committed-no-application-consumer-"))
  temporary_directories.push(job_dir)
  await publishCommittedEvidenceFixture({
    job_dir,
    component_evidence: componentEvidence(),
    application_plan: {
      version: 4,
      availability: "not_present",
      title: "No documented typical application",
      description: "The searched datasheet sections contain no reference circuit.",
      source_references: [text_source],
      searched_sections: ["Application information", "Typical characteristics"],
      components: [],
      connections: [],
    },
  })
  const original_store = new JobStore()
  original_store.createJob({
    job_id: "restore-no-application",
    job_dir,
    file_name: "fixture.pdf",
  })
  original_store.updateJob("restore-no-application", {
    typical_application_title: "Stale checkpoint title",
  })

  const restored = await restoreJobDirectory({
    job_id: "restore-no-application",
    job_dir,
    job_store: new JobStore(),
  })

  expect(restored?.evidence_available).toBe(true)
  expect(restored?.typical_application_title).toBeUndefined()
})

test("job restoration remains visible and reports corrupt committed evidence", async () => {
  const job_dir = await createCommittedJob()
  const evidence_dir = await committedEvidenceDir(job_dir)
  const original_store = new JobStore()
  original_store.createJob({
    job_id: "restore-corrupt-evidence",
    job_dir,
    file_name: "fixture.pdf",
  })
  original_store.updateJob("restore-corrupt-evidence", {
    display_status: "complete",
    is_complete: true,
    component_ready: false,
  })
  const mutable_evidence = (await Bun.file(join(evidence_dir, "component-evidence.json")).json()) as {
    part_number: { value: string }
  }
  mutable_evidence.part_number.value = "TAMPERED"
  await Bun.write(
    join(evidence_dir, "component-evidence.json"),
    `${JSON.stringify(mutable_evidence, null, 2)}\n`,
  )

  const restored = await restoreJobDirectory({
    job_id: "restore-corrupt-evidence",
    job_dir,
    job_store: new JobStore(),
  })

  expect(restored).toBeDefined()
  expect(restored?.evidence_available).toBe(false)
  expect(restored?.typical_application_title).toBeUndefined()
  expect(restored?.has_errors).toBe(true)
  expect(restored?.warnings).toContainEqual(
    expect.stringContaining("Committed evidence failed integrity validation"),
  )
})

test("approved evidence and model setup reject loose files without a commit marker", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "loose-evidence-consumer-"))
  temporary_directories.push(job_dir)
  await Promise.all([
    Bun.write(join(job_dir, "component-evidence.json"), `${JSON.stringify(componentEvidence())}\n`),
    Bun.write(join(job_dir, "typical-application-plan.json"), `${JSON.stringify(applicationPlan())}\n`),
  ])

  await expect(readApprovedEvidence(job_dir)).rejects.toThrow("evidence-commit.json has not been published")
  const model_dir = join(job_dir, "spice")
  await expect(prepareReferenceGraphInputs({ job_dir, model_dir, invocation_id: "loose" })).rejects.toThrow(
    "evidence-commit.json has not been published",
  )
  expect(await Bun.file(model_dir).exists()).toBe(false)
})
