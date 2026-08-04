import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  CheckedModelCandidate,
  ModelCandidateCheckReceipt,
} from "@/server/model-workflow/model-candidate-check"
import {
  assertModelTrainingCheckReceiptUsable,
  createModelTrainingCheckReceipt,
} from "@/server/model-workflow/model-training-check"
import type { ModelTrainingValidationReport } from "@/server/model-workflow/model-training-validation"

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const candidate: ModelCandidateCheckReceipt = {
  version: 1,
  status: "passed",
  checks: ["model_contract", "model_card", "ngspice_smoke"],
  revision: "a".repeat(16),
  entry_name: "MODEL",
  pin_count: 2,
  model_card_sha256: "b".repeat(64),
}

const checked = { receipt: candidate, generated: undefined as never } satisfies CheckedModelCandidate

function validation(input: { viewer?: boolean; extra_error?: string }): ModelTrainingValidationReport {
  const series = {
    observation_id: "vout",
    status: "failed" as const,
    metrics: { sample_count: 1, normalized_max_error: 0.2, normalized_rmse: 0.1 },
    samples: [{ x: 0, reference_y: 3.3, simulated_y: 3.2, error: -0.1 }],
    error_codes: ["curve_tolerance_exceeded"],
  }
  return {
    version: 1,
    status: "failed",
    cases: [
      {
        case_id: "load_step",
        status: "failed",
        server_series: [series],
        viewer_series: input.viewer === false ? [] : [series],
        error_codes: input.extra_error ? [input.extra_error] : [],
      },
    ],
    error_codes: input.extra_error ? [input.extra_error] : ["curve_tolerance_exceeded"],
  }
}

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "model-training-usable-"))
  temporary_directories.push(directory)
  await writeFile(
    join(directory, "model-training-plan.json"),
    JSON.stringify({
      version: 1,
      cases: [{ id: "load_step", observations: [{ id: "vout" }] }],
    }),
  )
  return directory
}

test("a complete finite comparison failure remains a usable authoritative-validation seed", async () => {
  const directory = await workspace()
  const receipt = await createModelTrainingCheckReceipt({
    workspace: directory,
    candidate,
    training_validation: validation({}),
  })
  await expect(
    assertModelTrainingCheckReceiptUsable({ workspace: directory, receipt, checked }),
  ).resolves.toBeUndefined()
})

test("finite ngspice output may advance for inspectable viewer diagnosis", async () => {
  const directory = await workspace()
  const missing_viewer = await createModelTrainingCheckReceipt({
    workspace: directory,
    candidate,
    training_validation: validation({ viewer: false }),
  })
  await expect(
    assertModelTrainingCheckReceiptUsable({
      workspace: directory,
      receipt: missing_viewer,
      checked,
    }),
  ).resolves.toBeUndefined()

  const unavailable = await createModelTrainingCheckReceipt({
    workspace: directory,
    candidate,
    training_validation: validation({ extra_error: "viewer_validation_unavailable" }),
  })
  await expect(
    assertModelTrainingCheckReceiptUsable({
      workspace: directory,
      receipt: unavailable,
      checked,
    }),
  ).resolves.toBeUndefined()

  const simulator_failure = await createModelTrainingCheckReceipt({
    workspace: directory,
    candidate,
    training_validation: validation({ extra_error: "simulator_execution_failed" }),
  })
  await expect(
    assertModelTrainingCheckReceiptUsable({
      workspace: directory,
      receipt: simulator_failure,
      checked,
    }),
  ).rejects.toThrow("simulator_execution_failed")
})
