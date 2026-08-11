import { expect, test } from "bun:test"
import { parseFootprintLandPatternInventory } from "@/server/component-workflow/footprint-land-pattern-inventory"
import { evidencePrompt } from "@/server/component-workflow/prompts"

test("land-pattern inventory finds physical package drawings without counting stencil representations", () => {
  const pdf_text = [
    "Cover page",
    "D0014A  SOIC - 14 pins\nLAND PATTERN EXAMPLE\nSCALE: 8X",
    "D0014A  SOIC - 14 pins\nEXAMPLE STENCIL DESIGN\nSOLDER PASTE EXAMPLE",
    "BQA0014A  WQFN - 14 pins\nLAND PATTERN EXAMPLE\nEXPOSED METAL SHOWN",
    "RUT0012A  UQFN - 12 pins\nLAND PATTERN EXAMPLE",
    "RUT0012A  repeated board view\nLAND PATTERN EXAMPLE",
  ].join("\f")

  const hints = parseFootprintLandPatternInventory(pdf_text)
  expect(hints).toEqual([
    { page: 2, drawing_code: "D0014A", package_code: "D", pin_count: 14 },
    { page: 4, drawing_code: "BQA0014A", package_code: "BQA", pin_count: 14 },
    { page: 5, drawing_code: "RUT0012A", package_code: "RUT", pin_count: 12 },
  ])
  expect(evidencePrompt({ footprint_hints: hints })).toContain("PDF page 4: package BQA, 14 pins")
})
