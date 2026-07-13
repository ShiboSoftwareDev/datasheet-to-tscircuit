import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createJobApiHandler } from "./job-api"
import { JobStore } from "./job-store"

export interface AppServerOptions {
  port?: number
  root_dir?: string
  job_store?: JobStore
}

function getStaticResponse(request: Request, root_dir: string): Response {
  const request_url = new URL(request.url)
  const decoded_path = decodeURIComponent(request_url.pathname)
  if (decoded_path.includes("..")) return new Response("Not found", { status: 404 })

  const dist_dir = join(root_dir, "dist")
  const requested_path = decoded_path === "/" ? "index.html" : decoded_path.replace(/^\//, "")
  const asset = Bun.file(join(dist_dir, requested_path))
  if (asset.size > 0) return new Response(asset)

  const index_file = Bun.file(join(dist_dir, "index.html"))
  if (index_file.size > 0) return new Response(index_file, { headers: { "Content-Type": "text/html" } })
  return new Response("Web build not found. Run `bun run dev` or `bun run build`.", { status: 404 })
}

export async function createAppServer(options: AppServerOptions = {}) {
  const root_dir = options.root_dir ?? resolve(import.meta.dir, "../..")
  const jobs_root = join(root_dir, ".runtime", "jobs")
  await mkdir(jobs_root, { recursive: true })

  const job_store = options.job_store ?? new JobStore()
  const handleApiRequest = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: process.env.TSCI_AGENT_BIN ?? join(root_dir, "node_modules", ".bin", "tsci-agent"),
    tsci_bin: process.env.TSCI_BIN ?? join(root_dir, "node_modules", ".bin", "tsci"),
  })

  return Bun.serve({
    port: options.port ?? Number(process.env.PORT ?? 3000),
    async fetch(request) {
      const api_response = await handleApiRequest(request)
      return api_response ?? getStaticResponse(request, root_dir)
    },
  })
}
