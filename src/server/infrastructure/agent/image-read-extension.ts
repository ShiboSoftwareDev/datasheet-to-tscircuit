import { stat } from "node:fs/promises"
import { extname, isAbsolute, resolve } from "node:path"
import { createReadTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent"

const MAX_DIRECT_IMAGE_BYTES = 3 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"])

/**
 * Keeps image reads deterministic in the production Bun image. Large source
 * images are rejected with an actionable message instead of disappearing in a
 * renderer-specific resize worker.
 */
export default function registerImageReadExtension(agent: ExtensionAPI): void {
  const workspace = process.cwd()
  const normal_read = createReadTool(workspace)
  const direct_image_read = createReadTool(workspace, { autoResizeImages: false })

  agent.registerTool({
    ...normal_read,
    async execute(tool_call_id, parameters, signal, on_update) {
      const requested_path = parameters.path
      if (!IMAGE_EXTENSIONS.has(extname(requested_path).toLowerCase())) {
        return normal_read.execute(tool_call_id, parameters, signal, on_update)
      }
      const absolute_path = isAbsolute(requested_path) ? requested_path : resolve(workspace, requested_path)
      const metadata = await stat(absolute_path).catch(() => undefined)
      if (metadata && metadata.size > MAX_DIRECT_IMAGE_BYTES) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Image is ${metadata.size} bytes. Create a review JPEG below ` +
                `${MAX_DIRECT_IMAGE_BYTES} bytes and read that file.`,
            },
          ],
          details: {},
        }
      }
      return direct_image_read.execute(tool_call_id, parameters, signal, on_update)
    },
  })
}
