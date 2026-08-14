// File-per-graph JSON storage under <config>/orchestration/. Pure Node
// fs/promises functions with no vscode dependency so they can be unit tested
// without an extension host. Mirrors the file-per-item convention used by the
// CLI's agent builder (one file per item, lazily created directory).

import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"
import {
  addOrchestrationEntry,
  coerceGraph,
  createGraph,
  renameOrchestrationNodes,
  summarize,
  type GraphSummary,
  type OrchestrationGraph,
} from "./domain"

export const FOLDER = "orchestration"

export function dirFor(configDir: string): string {
  return path.join(configDir, FOLDER)
}

/** Filesystem-safe stem for a graph id. */
export function safeId(raw: string): string {
  const id = raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return id || "graph"
}

/**
 * Parse stored graph JSON of any supported version. v1 graphs are migrated
 * to the v2 shape in memory; the file is rewritten as v2 only on save.
 * Returns null when unusable.
 */
export function parseGraph(raw: string): OrchestrationGraph | null {
  try {
    return coerceGraph(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function listGraphs(configDir: string): Promise<GraphSummary[]> {
  const dir = dirFor(configDir)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const graphs: GraphSummary[] = []
  for (const name of entries) {
    if (!name.endsWith(".json")) continue
    const graph = await readGraph(configDir, name.slice(0, -5))
    if (graph) graphs.push(summarize(graph))
  }
  graphs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return graphs
}

export async function readGraph(configDir: string, id: string): Promise<OrchestrationGraph | null> {
  try {
    const raw = await readFile(path.join(dirFor(configDir), `${safeId(id)}.json`), "utf8")
    return parseGraph(raw)
  } catch {
    return null
  }
}

export async function writeGraph(configDir: string, graph: OrchestrationGraph): Promise<OrchestrationGraph> {
  const dir = dirFor(configDir)
  await mkdir(dir, { recursive: true })
  const next = { ...graph, id: safeId(graph.id), updatedAt: new Date().toISOString() }
  await writeFile(path.join(dir, `${next.id}.json`), JSON.stringify(next, null, 2), "utf8")
  return next
}

export async function persistGraph(
  configDir: string,
  graph: OrchestrationGraph,
  persisted: boolean,
): Promise<{ saved: OrchestrationGraph; previous: OrchestrationGraph | null }> {
  const previous = persisted && graph.id ? await readGraph(configDir, graph.id) : null
  const id = previous ? previous.id : await uniqueId(configDir, graph.id || graph.name)
  const next = previous
    ? renameOrchestrationNodes({ ...graph, id }, previous.name)
    : addOrchestrationEntry({ ...graph, id })
  return { saved: await writeGraph(configDir, next), previous }
}

export async function deleteGraph(configDir: string, id: string): Promise<void> {
  await rm(path.join(dirFor(configDir), `${safeId(id)}.json`), { force: true })
}

/** Find an unused id derived from `base` in the storage directory. */
export async function uniqueId(configDir: string, base: string): Promise<string> {
  const dir = dirFor(configDir)
  let entries: string[] = []
  try {
    entries = await readdir(dir)
  } catch {
    // missing directory means nothing is taken yet
  }
  const taken = new Set(entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)))
  const stem = safeId(base)
  if (!taken.has(stem)) return stem
  let n = 2
  while (taken.has(`${stem}-${n}`)) n++
  return `${stem}-${n}`
}

export async function duplicateGraph(configDir: string, id: string): Promise<OrchestrationGraph | null> {
  const source = await readGraph(configDir, id)
  if (!source) return null
  const graph = createGraph(`${source.name} copy`)
  const copy: OrchestrationGraph = {
    ...source,
    id: await uniqueId(configDir, `${source.id}-copy`),
    name: graph.name,
    updatedAt: new Date().toISOString(),
  }
  return writeGraph(configDir, renameOrchestrationNodes(copy, source.name))
}

export async function renameGraph(configDir: string, id: string, name: string): Promise<OrchestrationGraph | null> {
  const graph = await readGraph(configDir, id)
  if (!graph) return null
  return writeGraph(configDir, renameOrchestrationNodes({ ...graph, name }, graph.name))
}
