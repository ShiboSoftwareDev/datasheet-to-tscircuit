import { expect, test } from "bun:test"
import { validatePdf } from "@/server/job-api"

test("validatePdf accepts PDF signatures and rejects unsafe uploads", () => {
  const valid_file = new File(["%PDF-1.7\nfixture"], "sensor.pdf", { type: "application/pdf" })
  const wrong_extension = new File(["%PDF-1.7\nfixture"], "sensor.txt", { type: "text/plain" })
  const wrong_signature = new File(["not a pdf"], "sensor.pdf", { type: "application/pdf" })

  expect(validatePdf(valid_file, new Uint8Array([37, 80, 68, 70, 45]))).toBeUndefined()
  expect(validatePdf(wrong_extension, new Uint8Array([37, 80, 68, 70, 45]))).toContain("PDF")
  expect(validatePdf(wrong_signature, new Uint8Array([110, 111, 116, 32, 97]))).toContain("valid PDF")
})
