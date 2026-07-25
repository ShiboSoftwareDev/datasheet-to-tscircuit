import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ArtifactWarningsDialog } from "@/web/components/artifact-warnings"

test("artifact warnings stay behind a compact header dialog trigger", () => {
  const html = renderToStaticMarkup(
    <ArtifactWarningsDialog
      artifact_label="SPICE model"
      warnings={["Benchmark validation was incomplete.", "One graph was duplicated."]}
    />,
  )

  expect(html).toContain('class="workspace-warning-count">2</span>')
  expect(html).toContain("View 2 SPICE model warnings")
  expect(html).toContain('title="2 SPICE model warnings"')
  expect(html).not.toContain("Benchmark validation was incomplete.")
  expect(html).not.toContain("One graph was duplicated.")
})

test("artifact warning trigger is omitted when the output has no warnings", () => {
  expect(renderToStaticMarkup(<ArtifactWarningsDialog artifact_label="Component" warnings={[]} />)).toBe("")
})
