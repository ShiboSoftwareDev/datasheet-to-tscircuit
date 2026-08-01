import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertValidationPlanSensitiveToDut } from "@/server/model-workflow/validation-sensitivity"
import { type ModelContract, parseModelContract } from "@/server/modeling"
import {
  executeLocalNgspice,
  parseAgentValidationPlan,
  parseValidationPlan,
  type ValidationPlan,
} from "@/server/spice-validation"

interface ModelAgentReplay {
  version: 1
  source: string
  contract: unknown
  proposal: unknown
}

const replay_files = ["run91-ina237.json", "run92-tps63802.json"]
const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function readReplay(file_name: string): Promise<{
  source: string
  contract: ModelContract
  proposal: unknown
}> {
  const path = join(import.meta.dir, "fixtures", "model-run-replays", file_name)
  const replay = (await Bun.file(path).json()) as ModelAgentReplay
  expect(replay.version).toBe(1)
  return {
    source: replay.source,
    contract: parseModelContract(replay.contract),
    proposal: replay.proposal,
  }
}

function parseProposal(replay: { contract: ModelContract; proposal: unknown }): ValidationPlan {
  return parseAgentValidationPlan(replay.proposal, {
    model_interface: replay.contract.interface,
    model_requirements: replay.contract.characterization.requirements,
    model_family: replay.contract.characterization.family,
  })
}

describe("production model-agent validation-plan replays", () => {
  test("normalizes the exact run 91/92 proposals while keeping persisted parsing strict", async () => {
    for (const file_name of replay_files) {
      const replay = await readReplay(file_name)
      const context = {
        model_interface: replay.contract.interface,
        model_requirements: replay.contract.characterization.requirements,
        model_family: replay.contract.characterization.family,
      }

      expect(() => parseValidationPlan(replay.proposal, context)).toThrow(/requirement_evidence_mismatch/)
      const canonical = parseProposal(replay)
      expect(canonical.cases).toHaveLength(4)
      expect(canonical.cases.flatMap(({ observations }) => observations)).toHaveLength(
        replay.source === "model-agent(91)" ? 5 : 4,
      )
      expect(
        canonical.cases
          .flatMap(({ observations }) => observations)
          .every(({ evidence }) => evidence?.image?.startsWith("evidence/source-page-")),
      ).toBe(true)

      if (replay.source === "model-agent(92)") {
        const full_load = canonical.cases.find(({ id }) => id === "full-load-minimum-input")
        expect(full_load?.observations[0]?.evidence).toEqual({
          page: 1,
          image: "evidence/source-page-1.png",
          metadata: { figure: "Features" },
        })
      }
    }
  })

  const ngspice_path = Bun.which("ngspice")
  const testWithNgspice = ngspice_path ? test : test.skip
  testWithNgspice("passes the real hidden DUT sensitivity gate for both retained plans", async () => {
    if (!ngspice_path) throw new Error("ngspice disappeared after test registration")
    for (const file_name of replay_files) {
      const replay = await readReplay(file_name)
      const plan = parseProposal(replay)
      const model_dir = await mkdtemp(join(tmpdir(), "model-agent-replay-"))
      temporary_directories.push(model_dir)
      await assertValidationPlanSensitiveToDut({
        plan,
        contract: replay.contract,
        model_dir,
        artifact_directory: join(model_dir, "sensitivity"),
        ngspice: executeLocalNgspice,
        ngspice_path,
      })
    }
  })
})
