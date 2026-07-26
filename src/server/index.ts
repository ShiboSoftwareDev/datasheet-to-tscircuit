import { createAppServer } from "./app-server"
import { getRuntimeSourceCommit } from "./runtime-source-commit"

const server = await createAppServer()
const source_commit = await getRuntimeSourceCommit()

console.log(`Datasheet to tscircuit API listening on ${server.url} (source ${source_commit})`)
