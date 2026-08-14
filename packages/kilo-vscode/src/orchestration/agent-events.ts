import { EventEmitter } from "events"
import type { AgentRename } from "./domain"

const emitter = new EventEmitter()

export function onAgentsRenamed(listener: (renames: AgentRename[]) => void): () => void {
  emitter.on("renamed", listener)
  return () => emitter.off("renamed", listener)
}

export function emitAgentsRenamed(renames: AgentRename[]): void {
  if (renames.length > 0) emitter.emit("renamed", renames)
}
