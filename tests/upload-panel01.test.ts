import { expect, test } from "bun:test"
import {
  AGENT_PROVIDER_STORAGE_KEY,
  getInitialUseOpenai,
  saveAgentProvider,
} from "@/web/agent-provider-preference"

function createStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(AGENT_PROVIDER_STORAGE_KEY, initial)
  return {
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
  }
}

test("the new-task provider preference persists the most recent selection", () => {
  const storage = createStorage()
  expect(getInitialUseOpenai(storage)).toBe(false)

  saveAgentProvider(true, storage)
  expect(getInitialUseOpenai(storage)).toBe(true)

  saveAgentProvider(false, storage)
  expect(getInitialUseOpenai(storage)).toBe(false)
  expect(storage.getItem(AGENT_PROVIDER_STORAGE_KEY)).toBe("tscircuit")
})

test("an unavailable or invalid provider preference safely falls back to the gateway", () => {
  expect(getInitialUseOpenai(undefined)).toBe(false)
  expect(getInitialUseOpenai(createStorage("unexpected-provider"))).toBe(false)
  expect(() =>
    saveAgentProvider(true, {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage disabled")
      },
    }),
  ).not.toThrow()
})
