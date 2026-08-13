// kilocode_change - new file
// Runtime validation for orchestration graphs: structural checks plus the
// bounded-loop and checkpoint-route rules the scheduler relies on. Mirrors
// the editor-side validation contract with runnable-oriented issues.

import {
  isAgentNode,
  isCheckpointNode,
  nodeById,
  nodeLabel,
  type OrchestrationEdge,
  type OrchestrationGraph,
} from "./domain"

export type GraphIssue = {
  code: string
  message: string
  nodeId?: string
  edgeId?: string
}

function validateEdge(
  issues: GraphIssue[],
  graph: OrchestrationGraph,
  ids: Set<string>,
  checkpoints: Map<string, unknown>,
  edge: OrchestrationEdge,
): void {
  if (edge.from === edge.to) {
    issues.push({ code: "self-loop", message: "A node cannot connect to itself", edgeId: edge.id })
  }
  if (!ids.has(edge.from) || !ids.has(edge.to)) {
    issues.push({ code: "dangling-edge", message: "A connection references a missing node", edgeId: edge.id })
    return
  }
  const fromCheckpoint = checkpoints.has(edge.from)
  if (edge.route.type === "forward") {
    if (graph.entryNodeId === edge.to) {
      issues.push({
        code: "forward-into-entry",
        message: "The entry node can only be reached through a bounded reprocessing connection",
        edgeId: edge.id,
      })
    }
  } else if (!edge.route.maxTraversals) {
    issues.push({
      code: "loop-limit-missing",
      message: "Reprocessing connections require a maximum traversal count",
      edgeId: edge.id,
    })
  }
  if (fromCheckpoint && !edge.route.outcome) {
    issues.push({
      code: "checkpoint-outcome-missing",
      message: "Connections from a checkpoint must select one of its outcomes",
      edgeId: edge.id,
    })
  }
  if (edge.route.outcome && !fromCheckpoint) {
    issues.push({
      code: "outcome-unused",
      message: "Only connections from a checkpoint can carry an outcome",
      edgeId: edge.id,
    })
  }
}

export function validateGraph(graph: OrchestrationGraph, knownAgents?: Iterable<string>): GraphIssue[] {
  const issues: GraphIssue[] = []
  const ids = new Set<string>()
  const checkpoints = new Map<string, unknown>()

  if (graph.nodes.length === 0) {
    issues.push({ code: "empty", message: "The graph has no nodes" })
  }

  const agents = knownAgents ? new Set(knownAgents) : undefined
  for (const node of graph.nodes) {
    if (ids.has(node.id)) {
      issues.push({ code: "duplicate-node", message: `Duplicate node id "${node.id}"`, nodeId: node.id })
    }
    ids.add(node.id)
    if (isAgentNode(node)) {
      if (agents && !agents.has(node.source.agentName)) {
        issues.push({
          code: "unknown-agent",
          message: `Unknown agent "${node.source.agentName}"`,
          nodeId: node.id,
        })
      }
    } else {
      checkpoints.set(node.id, node)
    }
  }

  if (!graph.entryNodeId) {
    issues.push({ code: "no-entry", message: "No entry node is set" })
  } else if (!ids.has(graph.entryNodeId)) {
    issues.push({ code: "missing-entry", message: "The entry node no longer exists", nodeId: graph.entryNodeId })
  }
  if (graph.outputNodeId && !ids.has(graph.outputNodeId)) {
    issues.push({ code: "missing-output", message: "The output node no longer exists", nodeId: graph.outputNodeId })
  }

  const edgeIds = new Set<string>()
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({ code: "duplicate-edge", message: `Duplicate connection id "${edge.id}"`, edgeId: edge.id })
    }
    edgeIds.add(edge.id)
    validateEdge(issues, graph, ids, checkpoints, edge)
  }

  // Two edges from one checkpoint sharing an outcome would be ambiguous.
  const seen = new Map<string, Set<string>>()
  for (const edge of graph.edges) {
    if (!checkpoints.has(edge.from)) continue
    const outcome = edge.route.outcome ?? ""
    const set = seen.get(edge.from) ?? new Set<string>()
    if (set.has(outcome)) {
      issues.push({
        code: "duplicate-outcome",
        message: "Multiple connections for the same checkpoint outcome",
        edgeId: edge.id,
      })
    }
    set.add(outcome)
    seen.set(edge.from, set)
  }

  // Checkpoint outcomes without a route can never be taken.
  for (const node of graph.nodes) {
    if (!isCheckpointNode(node)) continue
    for (const option of node.options) {
      const routed = graph.edges.some((edge) => edge.from === node.id && edge.route.outcome === option.id)
      if (!routed) {
        issues.push({
          code: "checkpoint-option-orphaned",
          message: `The "${option.label}" outcome has no outgoing connection`,
          nodeId: node.id,
        })
      }
    }
  }

  // Forward edges must not form unbounded cycles.
  const forward = new Map<string, OrchestrationEdge[]>()
  for (const edge of graph.edges) {
    if (edge.route.type !== "forward") continue
    const list = forward.get(edge.from) ?? []
    list.push(edge)
    forward.set(edge.from, list)
  }
  const visiting = new Set<string>()
  const done = new Set<string>()
  const visit = (nodeId: string, edgeId?: string): void => {
    if (done.has(nodeId)) return
    if (visiting.has(nodeId)) {
      if (edgeId) {
        issues.push({
          code: "forward-cycle",
          message: "Forward connections form an unbounded loop; mark it as reprocessing with a limit instead",
          edgeId,
        })
      }
      return
    }
    visiting.add(nodeId)
    for (const edge of forward.get(nodeId) ?? []) visit(edge.to, edge.id)
    visiting.delete(nodeId)
    done.add(nodeId)
  }
  for (const node of graph.nodes) visit(node.id)

  // Every node must be reachable from the entry.
  if (graph.entryNodeId && ids.has(graph.entryNodeId)) {
    const all = new Map<string, string[]>()
    for (const edge of graph.edges) {
      const list = all.get(edge.from) ?? []
      list.push(edge.to)
      all.set(edge.from, list)
    }
    const reachable = new Set<string>()
    const walk = (id: string): void => {
      if (reachable.has(id)) return
      reachable.add(id)
      for (const to of all.get(id) ?? []) walk(to)
    }
    walk(graph.entryNodeId)
    for (const node of graph.nodes) {
      if (!reachable.has(node.id)) {
        issues.push({
          code: "unreachable",
          message: `"${nodeLabel(node)}" is not reachable from the entry node`,
          nodeId: node.id,
        })
      }
    }
  }

  const terminal = graph.nodes.filter(
    (node) => !graph.edges.some((edge) => edge.from === node.id && edge.route.type === "forward"),
  )
  if (terminal.length > 1 && !graph.outputNodeId) {
    issues.push({
      code: "output-required",
      message: "The graph has multiple terminal nodes; set an output node",
    })
  }

  // The scheduler needs a starting node.
  const entry = graph.entryNodeId ? nodeById(graph, graph.entryNodeId) : undefined
  if (entry && isCheckpointNode(entry) && entry.options.length > 0 && entry.prompt === "") {
    issues.push({
      code: "checkpoint-prompt-missing",
      message: "The entry checkpoint has no question",
      nodeId: entry.id,
    })
  }

  return issues
}
