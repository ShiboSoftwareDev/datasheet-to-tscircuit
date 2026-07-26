import { stat } from "node:fs/promises"
import { extname, isAbsolute, resolve } from "node:path"
import { createReadTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent"

const IMAGE_READ_MARKER = "[datasheet-model-image-read]"
const MAX_DIRECT_IMAGE_BYTES = 3 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"])

function emitImageReadResult(input: { path: string; has_image: boolean; reason?: string }): void {
  process.stderr.write(`${IMAGE_READ_MARKER}${JSON.stringify(input)}\n`)
}

export default function registerModelAgentReadExtension(pi: ExtensionAPI): void {
  const cwd = process.cwd()
  const normal_read = createReadTool(cwd)
  // Pi's Photon resize worker is not available in the production Bun container.
  // Small, already prepared images can safely bypass that worker.
  const direct_image_read = createReadTool(cwd, { autoResizeImages: false })

  pi.registerTool({
    ...normal_read,
    async execute(tool_call_id, parameters, signal, on_update) {
      const requested_path = parameters.path
      const extension = extname(requested_path).toLowerCase()
      if (!IMAGE_EXTENSIONS.has(extension)) {
        return normal_read.execute(tool_call_id, parameters, signal, on_update)
      }

      const absolute_path = isAbsolute(requested_path) ? requested_path : resolve(cwd, requested_path)
      const metadata = await stat(absolute_path).catch(() => undefined)
      if (metadata && metadata.size > MAX_DIRECT_IMAGE_BYTES) {
        const reason =
          `Image is ${metadata.size} bytes; prepare a JPEG below ${MAX_DIRECT_IMAGE_BYTES} bytes ` +
          "with `bun prepare-vision-image.ts <input> <output.jpg>` and read that file."
        emitImageReadResult({ path: requested_path, has_image: false, reason })
        return {
          content: [{ type: "text" as const, text: `[Image omitted: ${reason}]` }],
          details: {},
        }
      }

      const result = await direct_image_read.execute(tool_call_id, parameters, signal, on_update)
      const has_image = result.content.some((block) => block.type === "image")
      const reason = has_image
        ? undefined
        : result.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join(" ")
            .slice(0, 500)
      emitImageReadResult({ path: requested_path, has_image, reason })
      return result
    },
  })
}
