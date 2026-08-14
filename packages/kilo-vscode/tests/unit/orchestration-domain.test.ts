import { describe, expect, it } from "bun:test"
import {
  agentRole,
  coerceGraph,
  connectError,
  createAgentNode,
  createCheckpointNode,
  createEdge,
  createGraph,
  nodeLabel,
  isOrchestrationAgent,
  orchestrationAgentName,
  orchestrationAgentGraphId,
  slugify,
  summarize,
  validateGraph,
} from "../../src/orchestration/domain"
import type { OrchestrationGraph, OrchestrationNode } from "../../src/orchestration/domain"

function node(id: string, agentName: string, x = 0, y = 0): OrchestrationNode {
  return createAgentNode(id, agentName, { x, y })
}

function graph(patch: Partial<OrchestrationGraph>): OrchestrationGraph {
  return { ...createGraph("Demo"), ...patch }
}

const codes = (issues: { code: string }[]) => issues.map((issue) => issue.code)

describe("orchestration domain", () => {
  it("slugifies names into valid agent slugs", () => {
    expect(slugify("Release Pipeline")).toBe("release-pipeline")
    expect(slugify("  Weird!! Name?? ")).toBe("weird-name")
    expect(slugify("9lives")).toBe("orchestration-9lives")
    expect(slugify("")).toBe("orchestration")
    expect(slugify("!!!")).toBe("orchestration")
  })

  it("creates version 2 graphs with an output slot", () => {
    const item = createGraph("Demo")
    expect(item.version).toBe(2)
    expect(item.outputNodeId).toBeNull()
  })

  it("summarizes graphs for the gallery", () => {
    const item = graph({ id: "demo", nodes: [node("a", "code"), node("b", "review")] })
    expect(summarize(item)).toMatchObject({ id: "demo", name: "Demo", nodes: 2 })
  })

  it("identifies published orchestration agents", () => {
    expect(
      isOrchestrationAgent({
        options: { kiloOrchestration: { version: 2, graph: { id: "demo", scope: "global" } } },
      }),
    ).toBe(true)
    expect(isOrchestrationAgent({ options: {} })).toBe(false)
    expect(
      isOrchestrationAgent({
        options: { kiloOrchestration: { version: 2, graph: { id: "demo", scope: "project" } } },
      }),
    ).toBe(false)
  })

  it("classifies agents using the Agents tab metadata", () => {
    expect(agentRole({ mode: "primary" })).toBe("agent")
    expect(agentRole({ mode: "all" })).toBe("agent")
    expect(agentRole({ mode: "subagent" })).toBe("subagent")
    expect(
      agentRole({
        mode: "primary",
        options: { kiloOrchestration: { version: 2, graph: { id: "demo", scope: "global" } } },
      }),
    ).toBe("orchestrator")
    expect(agentRole(undefined)).toBeUndefined()
  })

  it("reads names from current and legacy orchestration agents", () => {
    const options = { kiloOrchestration: { version: 2, graph: { id: "demo", scope: "global" } } }
    expect(orchestrationAgentName({ displayName: "Current Name", description: "ignored", options })).toBe(
      "Current Name",
    )
    expect(orchestrationAgentName({ description: 'Deterministic orchestration "Legacy Name"', options })).toBe(
      "Legacy Name",
    )
    expect(orchestrationAgentName({ description: "Ordinary agent", options: {} })).toBeUndefined()
  })

  it("reads the graph id from an orchestration agent", () => {
    expect(
      orchestrationAgentGraphId({
        options: { kiloOrchestration: { version: 2, graph: { id: "demo", scope: "global" } } },
      }),
    ).toBe("demo")
    expect(orchestrationAgentGraphId({ options: {} })).toBeUndefined()
  })

  it("labels nodes by override display name", () => {
    const base = node("a", "code")
    expect(nodeLabel(base)).toBe("code")
    const renamed = createAgentNode("b", "code", { x: 0, y: 0 })
    renamed.overrides.displayName = "Planner A"
    expect(nodeLabel(renamed)).toBe("Planner A")
    expect(nodeLabel(createCheckpointNode("c", { x: 0, y: 0 }))).toBe("User checkpoint")
  })

  it("creates checkpoint nodes with default display and input config", () => {
    const cp = createCheckpointNode("cp", { x: 0, y: 0 })
    expect(cp.display?.mode).toBe("predecessors")
    expect(cp.input?.mode).toBe("optional")
  })

  it("coerces checkpoint display and input fields with defaults", () => {
    const g = coerceGraph({
      id: "g",
      name: "Test",
      nodes: [{ id: "cp", kind: "checkpoint", position: { x: 0, y: 0 }, prompt: "OK?", options: [] }],
      edges: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    })!
    const cp = g.nodes[0]!
    expect(cp.kind).toBe("checkpoint")
    if (cp.kind === "checkpoint") {
      expect(cp.display?.mode).toBe("predecessors")
      expect(cp.input?.mode).toBe("optional")
    }
  })

  it("coerces checkpoint display and input with explicit values", () => {
    const g = coerceGraph({
      id: "g",
      name: "Test",
      nodes: [
        {
          id: "cp",
          kind: "checkpoint",
          position: { x: 0, y: 0 },
          prompt: "OK?",
          options: [],
          display: { mode: "none" },
          input: { mode: "required", placeholder: "Enter details" },
        },
      ],
      edges: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    })!
    const cp = g.nodes[0]!
    if (cp.kind === "checkpoint") {
      expect(cp.display?.mode).toBe("none")
      expect(cp.input?.mode).toBe("required")
      expect(cp.input?.placeholder).toBe("Enter details")
    }
  })

  it("flags a graph with no entry node", () => {
    const issues = validateGraph(graph({ nodes: [node("a", "code")] }))
    expect(codes(issues)).toContain("no-entry")
  })

  it("flags an entry node that no longer exists", () => {
    const issues = validateGraph(graph({ nodes: [node("a", "code")], entryNodeId: "missing" }))
    expect(codes(issues)).toContain("missing-entry")
  })

  it("flags self-loops and dangling edges", () => {
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [node("a", "code"), node("b", "review")],
        edges: [{ ...createEdge("e1", "b", "b") }, { ...createEdge("e2", "a", "gone") }],
      }),
    )
    expect(codes(issues)).toContain("self-loop")
    expect(codes(issues)).toContain("dangling-edge")
  })

  it("rejects forward edges into the entry node", () => {
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [node("a", "code"), node("b", "review")],
        edges: [{ ...createEdge("e1", "b", "a") }],
      }),
    )
    expect(codes(issues)).toContain("forward-into-entry")
  })

  it("allows a bounded reprocessing edge into the entry node", () => {
    const edge = createEdge("e1", "b", "a")
    edge.route = { type: "reprocess", maxTraversals: 2, onLimit: "continue" }
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [node("a", "code"), node("b", "review")],
        edges: [{ ...createEdge("e0", "a", "b") }, edge],
      }),
    )
    expect(issues).toEqual([])
  })

  it("requires a traversal limit on reprocessing edges", () => {
    const edge = createEdge("e1", "b", "a")
    edge.route = { type: "reprocess" }
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [node("a", "code"), node("b", "review")],
        edges: [{ ...createEdge("e0", "a", "b") }, edge],
      }),
    )
    expect(codes(issues)).toContain("loop-limit-missing")
  })

  it("rejects unbounded forward cycles and identifies the back edge", () => {
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [node("a", "code"), node("b", "review")],
        edges: [{ ...createEdge("e1", "a", "b") }, { ...createEdge("e2", "b", "a") }],
      }),
    )
    const cycle = issues.find((issue) => issue.code === "forward-cycle")
    expect(cycle).toBeDefined()
    expect(cycle!.edgeId).toBe("e2")
  })

  it("accepts a forward graph that only loops via a bounded reprocess edge", () => {
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [node("a", "arch"), node("b", "plan"), node("c", "reconcile")],
        edges: [
          { ...createEdge("e1", "a", "b") },
          { ...createEdge("e2", "b", "c") },
          { ...createEdge("e3", "c", "a"), route: { type: "reprocess", maxTraversals: 2, onLimit: "continue" } },
        ],
      }),
    )
    expect(issues).toEqual([])
  })

  it("flags nodes referencing unknown agents when a roster is provided", () => {
    const issues = validateGraph(graph({ nodes: [node("a", "ghost")] }), ["code", "review"])
    expect(codes(issues)).toContain("unknown-agent")
  })

  it("flags unreachable nodes", () => {
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [node("a", "code"), node("b", "review")],
      }),
    )
    expect(codes(issues)).toContain("unreachable")
  })

  it("requires an output node when the graph has multiple terminals", () => {
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [node("a", "code"), node("b", "review"), node("c", "docs")],
        edges: [{ ...createEdge("e1", "a", "b") }, { ...createEdge("e2", "a", "c") }],
      }),
    )
    expect(codes(issues)).toContain("output-required")
  })

  it("accepts a graph with one terminal and no explicit output", () => {
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [node("a", "code")],
      }),
    )
    expect(issues).toEqual([])
  })

  it("flags an output node that no longer exists", () => {
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        outputNodeId: "ghost",
        nodes: [node("a", "code")],
      }),
    )
    expect(codes(issues)).toContain("missing-output")
  })

  it("requires checkpoint edges to carry a valid outcome", () => {
    const checkpoint = createCheckpointNode("cp", { x: 0, y: 0 })
    checkpoint.options = [
      { id: "accept", label: "Accept" },
      { id: "changes", label: "Request changes" },
    ]
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [node("a", "code"), checkpoint],
        edges: [
          { ...createEdge("e1", "a", "cp") },
          { ...createEdge("e2", "cp", "a"), route: { type: "reprocess", maxTraversals: 2 } },
          { ...createEdge("e3", "cp", "a"), route: { type: "forward", outcome: "nope" } },
        ],
      }),
    )
    const missing = issues.find((issue) => issue.code === "checkpoint-outcome-missing")
    const unknown = issues.find((issue) => issue.code === "checkpoint-outcome-unknown")
    expect(missing).toBeDefined()
    expect(missing!.edgeId).toBe("e2")
    expect(unknown).toBeDefined()
    expect(unknown!.edgeId).toBe("e3")
  })

  it("flags checkpoint options without an outgoing route", () => {
    const checkpoint = createCheckpointNode("cp", { x: 0, y: 0 })
    checkpoint.options = [{ id: "accept", label: "Accept" }]
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [node("a", "code"), checkpoint],
        edges: [{ ...createEdge("e1", "a", "cp") }],
      }),
    )
    expect(codes(issues)).toContain("checkpoint-option-orphaned")
  })

  it("flags two checkpoint edges sharing one outcome", () => {
    const checkpoint = createCheckpointNode("cp", { x: 0, y: 0 })
    checkpoint.options = [{ id: "accept", label: "Accept" }]
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [node("a", "code"), node("b", "review"), checkpoint],
        edges: [
          { ...createEdge("e1", "a", "cp") },
          { ...createEdge("e2", "cp", "a"), route: { type: "reprocess", maxTraversals: 2, outcome: "accept" } },
          { ...createEdge("e3", "cp", "b"), route: { type: "forward", outcome: "accept" } },
        ],
      }),
    )
    expect(codes(issues)).toContain("duplicate-outcome")
  })

  it("rejects an outcome on edges that do not leave a checkpoint", () => {
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [node("a", "code"), node("b", "review")],
        edges: [{ ...createEdge("e1", "a", "b"), route: { type: "forward", outcome: "accept" } }],
      }),
    )
    expect(codes(issues)).toContain("outcome-unused")
  })

  it("accepts a coherent graph", () => {
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [node("a", "code"), node("b", "review")],
        edges: [{ ...createEdge("e1", "a", "b") }],
      }),
      ["code", "review"],
    )
    expect(issues).toEqual([])
  })

  it("rejects invalid connections with a reason", () => {
    const item = graph({
      entryNodeId: "a",
      nodes: [node("a", "code"), node("b", "review")],
      edges: [{ ...createEdge("e1", "a", "b") }],
    })
    expect(connectError(item, "a", "a")).toContain("itself")
    expect(connectError(item, "a", "b")).toContain("Already connected")
    expect(connectError(item, "a", "ghost")).toContain("Unknown node")
  })

  it("allows connecting into the entry node (bounds enforced later)", () => {
    const item = graph({ entryNodeId: "a", nodes: [node("a", "code"), node("b", "review")] })
    expect(connectError(item, "b", "a")).toBeNull()
  })

  it("coerces version 1 graphs to version 2 in memory", () => {
    const migrated = coerceGraph({
      id: "legacy",
      name: "Legacy",
      entryNodeId: "n1",
      nodes: [
        {
          id: "n1",
          kind: "subagent",
          agentName: "plan",
          position: { x: 1, y: 2 },
          capabilities: { skills: ["chart"], mcpServers: [] },
        },
        {
          id: "n2",
          kind: "agent",
          agentName: "code",
          position: { x: 3, y: 4 },
          capabilities: { skills: [], mcpServers: ["github"] },
        },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", meta: { junk: true } }],
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    expect(migrated).not.toBeNull()
    expect(migrated!.version).toBe(2)
    expect(migrated!.outputNodeId).toBeNull()
    expect(migrated!.nodes[0]).toMatchObject({
      kind: "agent",
      source: { agentName: "plan" },
      capabilities: { skills: ["chart"], mcpServers: [] },
    })
    expect(migrated!.nodes[1].kind).toBe("agent")
    expect(migrated!.edges[0].route).toEqual({ type: "forward" })
  })

  it("coerces checkpoint nodes and typed routes", () => {
    const graph = coerceGraph({
      id: "v2",
      name: "V2",
      entryNodeId: "a",
      outputNodeId: "b",
      nodes: [
        {
          id: "a",
          kind: "agent",
          source: { agentName: "code" },
          position: { x: 0, y: 0 },
          overrides: { model: { providerID: "kilo", modelID: "auto" }, prompt: { mode: "append", text: "hi" } },
          capabilities: {},
          runtime: { retries: 3, failure: "continue" },
        },
        { id: "cp", kind: "checkpoint", position: { x: 0, y: 0 }, prompt: "OK?", options: [{ id: "y", label: "Yes" }] },
      ],
      edges: [
        { id: "e1", from: "a", to: "cp", route: { type: "forward", outcome: "y" } },
        { id: "e2", from: "cp", to: "a", route: { type: "reprocess", maxTraversals: 3, onLimit: "fail" } },
      ],
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    expect(graph).not.toBeNull()
    expect(graph!.outputNodeId).toBe("b")
    const first = graph!.nodes[0]
    expect(first.kind).toBe("agent")
    if (first.kind === "agent") {
      expect(first.overrides.model).toEqual({ providerID: "kilo", modelID: "auto" })
      expect(first.overrides.prompt).toEqual({ mode: "append", text: "hi" })
      expect(first.runtime).toMatchObject({ retries: 3, failure: "continue" })
    }
    const cp = graph!.nodes[1]
    expect(cp.kind).toBe("checkpoint")
    if (cp.kind === "checkpoint") expect(cp.options).toEqual([{ id: "y", label: "Yes" }])
    expect(graph!.edges[0].route).toEqual({ type: "forward", outcome: "y" })
    expect(graph!.edges[1].route).toEqual({ type: "reprocess", maxTraversals: 3, onLimit: "fail" })
  })

  it("preserves editable connection control points", () => {
    const result = coerceGraph({
      id: "curves",
      name: "Curves",
      version: 2,
      entryNodeId: "a",
      outputNodeId: "b",
      nodes: [node("a", "code"), node("b", "review")],
      edges: [
        {
          id: "e1",
          from: "a",
          to: "b",
          route: { type: "forward" },
          meta: {
            controls: [
              { x: 12, y: 34 },
              { x: 56, y: 78 },
            ],
          },
        },
      ],
      updatedAt: "2026-01-01T00:00:00.000Z",
    })

    expect(result?.edges[0].meta?.controls).toEqual([
      { x: 12, y: 34 },
      { x: 56, y: 78 },
    ])
  })

  it("rejects non-graph values", () => {
    expect(coerceGraph(null)).toBeNull()
    expect(coerceGraph({})).toBeNull()
    expect(coerceGraph({ id: "x", name: "X" })).toBeNull()
  })
})
