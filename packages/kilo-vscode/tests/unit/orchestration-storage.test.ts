import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createAgentNode, createGraph } from "../../src/orchestration/domain"
import type { OrchestrationGraph } from "../../src/orchestration/domain"
import {
  deleteGraph,
  dirFor,
  duplicateGraph,
  listGraphs,
  parseGraph,
  persistGraph,
  readGraph,
  renameGraph,
  safeId,
  uniqueId,
  writeGraph,
} from "../../src/orchestration/graph-storage"

describe("orchestration graph storage", () => {
  let configDir: string

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestration-storage-"))
  })

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  function seed(name: string, patch: Partial<OrchestrationGraph> = {}): OrchestrationGraph {
    return { ...createGraph(name), ...patch }
  }

  it("sanitizes ids into filesystem-safe stems", () => {
    expect(safeId("My Graph!!")).toBe("my-graph")
    expect(safeId("../escape")).toBe("escape")
    expect(safeId("")).toBe("graph")
  })

  it("writes and reads a graph round-trip", async () => {
    const graph = seed("Pipeline", {
      nodes: [createAgentNode("n1", "code", { x: 10, y: 20 })],
    })
    const written = await writeGraph(configDir, graph)
    const read = await readGraph(configDir, written.id)
    expect(read?.name).toBe("Pipeline")
    expect(read?.version).toBe(2)
    expect(read?.nodes[0].kind).toBe("agent")
    if (read?.nodes[0].kind === "agent") {
      expect(read.nodes[0].source.agentName).toBe("code")
      expect(read.nodes[0].capabilities.skills).toEqual([])
      expect(read.nodes[0].runtime).toMatchObject({ retries: 0, failure: "stop" })
    }
    expect(read?.updatedAt).toBeTruthy()
  })

  it("returns null when reading a missing graph", async () => {
    expect(await readGraph(configDir, "nope")).toBeNull()
  })

  it("lists graphs and tolerates corrupt files", async () => {
    await writeGraph(configDir, seed("Good One"))
    fs.mkdirSync(dirFor(configDir), { recursive: true })
    fs.writeFileSync(path.join(dirFor(configDir), "broken.json"), "{ not json", "utf8")
    fs.writeFileSync(path.join(dirFor(configDir), "notagraph.json"), JSON.stringify({ foo: 1 }), "utf8")
    const graphs = await listGraphs(configDir)
    expect(graphs).toHaveLength(1)
    expect(graphs[0].name).toBe("Good One")
  })

  it("produces unique ids when the stem is taken", async () => {
    expect(await uniqueId(configDir, "pipeline")).toBe("pipeline")
    await writeGraph(configDir, seed("pipeline"))
    expect(await uniqueId(configDir, "pipeline")).toBe("pipeline-2")
    await writeGraph(configDir, { ...seed("pipeline"), id: "pipeline-2" })
    expect(await uniqueId(configDir, "pipeline")).toBe("pipeline-3")
  })

  it("duplicates a graph with a fresh id and copy suffix", async () => {
    const original = await writeGraph(configDir, seed("Pipeline"))
    const copy = await duplicateGraph(configDir, original.id)
    expect(copy).not.toBeNull()
    expect(copy!.id).not.toBe(original.id)
    expect(copy!.name).toBe("Pipeline copy")
    const graphs = await listGraphs(configDir)
    expect(graphs).toHaveLength(2)
  })

  it("renames a graph in place", async () => {
    const graph = await writeGraph(configDir, seed("Before"))
    const renamed = await renameGraph(configDir, graph.id, "After")
    expect(renamed?.name).toBe("After")
    expect((await readGraph(configDir, graph.id))?.name).toBe("After")
  })

  it("preserves a stored graph id when its editor name changes", async () => {
    const graph = await writeGraph(configDir, seed("Before"))
    const result = await persistGraph(configDir, { ...graph, name: "After" }, true)
    expect(result.saved.id).toBe(graph.id)
    expect(result.previous?.name).toBe("Before")
    expect((await listGraphs(configDir)).map((item) => item.name)).toEqual(["After"])
  })

  it("adds the published orchestrator as a new graph's default entry", async () => {
    const result = await persistGraph(configDir, seed("Release Plan"), false)
    expect(result.saved.nodes).toHaveLength(1)
    expect(result.saved.entryNodeId).toBe(result.saved.nodes[0].id)
    const entry = result.saved.nodes[0]
    expect(entry.kind).toBe("agent")
    if (entry.kind === "agent") {
      expect(entry.source.agentName).toBe("release-plan")
      expect(entry.overrides.displayName).toBe("Release Plan")
      expect(entry.position).toEqual({ x: 0, y: 0 })
    }
  })

  it("renames an existing orchestrator node without restoring a removed one", async () => {
    const created = await persistGraph(configDir, seed("Before"), false)
    const renamed = await persistGraph(configDir, { ...created.saved, name: "After" }, true)
    const entry = renamed.saved.nodes[0]
    expect(entry.kind).toBe("agent")
    if (entry.kind === "agent") {
      expect(entry.source.agentName).toBe("after")
      expect(entry.overrides.displayName).toBe("After")
    }

    const removed = await persistGraph(
      configDir,
      { ...renamed.saved, name: "Final", entryNodeId: null, nodes: [] },
      true,
    )
    expect(removed.saved.nodes).toEqual([])
    expect(removed.saved.entryNodeId).toBeNull()
  })

  it("gives a new graph a unique id instead of overwriting a slug collision", async () => {
    await writeGraph(configDir, seed("Existing", { id: "same" }))
    const result = await persistGraph(configDir, seed("New", { id: "same" }), false)
    expect(result.saved.id).toBe("same-2")
    expect(await listGraphs(configDir)).toHaveLength(2)
  })

  it("deletes a graph and is idempotent", async () => {
    const graph = await writeGraph(configDir, seed("Pipeline"))
    await deleteGraph(configDir, graph.id)
    await deleteGraph(configDir, graph.id)
    expect(await readGraph(configDir, graph.id)).toBeNull()
  })

  it("repairs drifted fields while parsing", () => {
    const raw = JSON.stringify({
      id: "x",
      name: "X",
      entryNodeId: 42,
      nodes: [
        { id: "n", kind: "weird", agentName: "code", position: { x: "5" }, capabilities: { skills: "nope" } },
        null,
      ],
      edges: [{ id: "e", from: "n", to: "n", junk: true }, "bad"],
    })
    const graph = parseGraph(raw)
    expect(graph).not.toBeNull()
    expect(graph!.entryNodeId).toBeNull()
    expect(graph!.nodes).toHaveLength(1)
    expect(graph!.nodes[0].kind).toBe("agent")
    if (graph!.nodes[0].kind === "agent") {
      expect(graph!.nodes[0].source.agentName).toBe("code")
      expect(graph!.nodes[0].position.x).toBe(5)
      expect(graph!.nodes[0].capabilities.skills).toEqual([])
    }
    expect(graph!.edges).toHaveLength(1)
    expect(graph!.edges[0].route).toEqual({ type: "forward" })
  })

  it("migrates version 1 graphs to version 2 on load", async () => {
    const dir = dirFor(configDir)
    fs.mkdirSync(dir, { recursive: true })
    const v1 = {
      id: "legacy",
      name: "Legacy",
      entryNodeId: "a",
      nodes: [
        {
          id: "a",
          kind: "agent",
          agentName: "code",
          position: { x: 0, y: 0 },
          capabilities: { skills: [], mcpServers: [] },
        },
        {
          id: "b",
          kind: "subagent",
          agentName: "review",
          position: { x: 0, y: 0 },
          capabilities: { skills: [], mcpServers: [] },
        },
      ],
      edges: [{ id: "e1", from: "a", to: "b" }],
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    fs.writeFileSync(path.join(dir, "legacy.json"), JSON.stringify(v1), "utf8")
    const graph = await readGraph(configDir, "legacy")
    expect(graph).not.toBeNull()
    expect(graph!.version).toBe(2)
    expect(graph!.outputNodeId).toBeNull()
    const first = graph!.nodes[0]
    expect(first.kind).toBe("agent")
    if (first.kind === "agent") expect(first.source.agentName).toBe("code")
    const second = graph!.nodes[1]
    expect(second.kind).toBe("agent")
    if (second.kind === "agent") expect(second.source.agentName).toBe("review")
    expect(graph!.edges[0].route).toEqual({ type: "forward" })
    // The file stays v1 until the user saves.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "legacy.json"), "utf8")) as { version?: number }
    expect(onDisk.version ?? 1).toBe(1)
  })

  it("rejects non-graph JSON", () => {
    expect(parseGraph("{}")).toBeNull()
    expect(parseGraph("[1,2]")).toBeNull()
  })
})
