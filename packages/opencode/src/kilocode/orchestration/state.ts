// kilocode_change - new file
// Orchestration run state: persisted snapshot of one workflow execution.
// Pure types + a factory; the scheduler mutates and exposes it.

import { createId, type CheckpointContextItem, type OrchestrationGraph } from "./domain"

export type RunStatus = "running" | "waiting-for-user" | "completed" | "failed" | "cancelled"

export type NodeStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

export type NodeRun = {
  nodeId: string
  /** Execution round; increments on each reprocessing traversal. */
  round: number
  status: NodeStatus
  attempts: number
  output?: string
  error?: string
  sessionID?: string
  startedAt?: number
  finishedAt?: number
}

export type EdgeRun = {
  traversals: number
}

export type CheckpointResolution = {
  round: number
  outcome: string
  feedback?: string
}

export type OrchestrationRun = {
  id: string
  graphId: string
  graphName: string
  graph: OrchestrationGraph
  directory?: string
  status: RunStatus
  input: string
  nodes: Record<string, NodeRun[]>
  edges: Record<string, EdgeRun>
  checkpoints: Record<string, CheckpointResolution[]>
  createdAt: number
  updatedAt: number
  revision: number
  waiting?: {
    nodeId: string
    round: number
    prompt: string
    options: Array<{ id: string; label: string }>
    title?: string
    displayMode?: "none" | "predecessors"
    inputMode?: "none" | "optional" | "required"
    inputPlaceholder?: string
    context?: CheckpointContextItem[]
  }
  error?: string
  output?: string
}

export function createRun(graph: OrchestrationGraph, input: string): OrchestrationRun {
  const now = Date.now()
  return {
    id: createId("run"),
    graphId: graph.id,
    graphName: graph.name,
    graph: structuredClone(graph),
    status: "running",
    input,
    nodes: {},
    edges: Object.fromEntries(graph.edges.map((edge) => [edge.id, { traversals: 0 }])),
    checkpoints: {},
    createdAt: now,
    updatedAt: now,
    revision: 0,
  }
}

export function latestRun(runs: NodeRun[] | undefined): NodeRun | undefined {
  if (!runs || runs.length === 0) return undefined
  return runs[runs.length - 1]
}

export function runInRound(runs: NodeRun[] | undefined, round: number): NodeRun | undefined {
  return runs?.find((run) => run.round === round)
}
