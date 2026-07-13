import { expect, test } from "bun:test"
import { resolveServerHostname } from "@/server/app-server"

test("the app server binds to loopback by default", () => {
  expect(resolveServerHostname(undefined, undefined)).toBe("127.0.0.1")
})

test("an explicit hostname overrides the environment hostname", () => {
  expect(resolveServerHostname("0.0.0.0", "localhost")).toBe("0.0.0.0")
})
