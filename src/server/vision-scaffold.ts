import { join } from "node:path"

export const VISION_RENDERER_FILENAME = "render-svg-to-png.ts"

const VISION_RENDERER_SOURCE = `import { Resvg } from "@resvg/resvg-js"
import { extname } from "node:path"

const inputFiles = Bun.argv.slice(2)

if (inputFiles.length === 0) {
  throw new Error("Usage: bun render-svg-to-png.ts <image.svg> [more.svg ...]")
}

for (const inputFile of inputFiles) {
  if (extname(inputFile).toLowerCase() !== ".svg") {
    throw new Error(\`Expected an SVG input, received: \${inputFile}\`)
  }

  const svg = await Bun.file(inputFile).text()
  const outputFile = inputFile.slice(0, -4) + ".png"
  const png = new Resvg(svg, {
    background: "white",
    fitTo: { mode: "width", value: 1800 },
  }).render().asPng()

  await Bun.write(outputFile, png)
  console.log(outputFile)
}
`

export async function writeVisionRenderer(directory: string): Promise<void> {
  await Bun.write(join(directory, VISION_RENDERER_FILENAME), VISION_RENDERER_SOURCE)
}
