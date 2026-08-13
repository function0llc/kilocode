import { Global } from "@opencode-ai/core/global"
import path from "path"
import { coerceGraph, type OrchestrationGraph } from "./domain"

export type Binding = { version: 2; graph: { id: string; scope: "global" } }

export function binding(value: unknown): Binding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const raw = value as Record<string, unknown>
  if (raw.version !== 2 || !raw.graph || typeof raw.graph !== "object" || Array.isArray(raw.graph)) return
  const graph = raw.graph as Record<string, unknown>
  if (typeof graph.id !== "string" || !graph.id || graph.scope !== "global") return
  return { version: 2, graph: { id: graph.id, scope: "global" } }
}

export async function loadGraph(id: string): Promise<OrchestrationGraph> {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_") || "graph"
  const file = Bun.file(path.join(Global.Path.config, "orchestration", `${safe}.json`))
  if (!(await file.exists())) throw new Error(`Orchestration graph not found: ${id}`)
  const graph = coerceGraph(await file.json())
  if (!graph) throw new Error(`Orchestration graph is invalid: ${id}`)
  return graph
}
