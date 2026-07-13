import { createAppServer } from "./app-server"

const server = await createAppServer()

console.log(`Datasheet to tscircuit API listening on ${server.url}`)
