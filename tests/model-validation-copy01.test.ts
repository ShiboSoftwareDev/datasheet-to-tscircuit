import { expect, test } from "bun:test"
import { getChampionValidationCopy } from "@/web/model-validation-copy"

test("champion status distinguishes agent progress from independent validation", () => {
  expect(getChampionValidationCopy(undefined)).toBe("Not validated")
  expect(getChampionValidationCopy({ passing_count: 3, benchmark_count: 4 })).toBe("3/4 passing")
})
