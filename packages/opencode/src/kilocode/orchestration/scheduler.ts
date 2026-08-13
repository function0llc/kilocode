// kilocode_change - new file
// Deterministic orchestration scheduler. Owns graph traversal, parallel
// scheduling, fan-in barriers, bounded reprocessing rounds, retries, failure
// policies, user checkpoints, and cancellation. The node executor boundary is
// injected so scheduling can be unit-tested without an LLM.
//
// Execution model:
//   - Round 0 starts at the entry node and follows forward edges.
//   - A node is runnable when every incoming forward source is terminal for
//     the current round (or satisfied by an earlier round when the source is
//     outside the round's re-run set).
//   - Runnable siblings launch concurrently (bounded concurrency).
//   - A fan-in node receives labelled predecessor results; siblings never see
//     each other's output.
//   - Checkpoints pause the run; the driver resolves them via respond().
//   - A checkpoint outcome routed to a reprocessing edge starts a new round
//     at the edge target (bounded by maxTraversals). Node retries do not
//     consume the reprocessing budget.

import {
  isAgentNode,
  isCheckpointNode,
  nodeById,
  nodeLabel,
  type AgentNode,
  type CheckpointNode,
  type CheckpointOption,
  type OrchestrationEdge,
  type OrchestrationGraph,
  type OrchestrationNode,
} from "./domain"
import { createRun, latestRun, runInRound, type NodeRun, type OrchestrationRun } from "./state"
import { validateGraph } from "./validate"

export type PredecessorResult = {
  nodeId: string
  label: string
  round: number
  output?: string
  failed?: boolean
  error?: string
}

export type NodeExecution = {
  runId: string
  nodeId: string
  agentName: string
  round: number
  attempt: number
  input: string
  predecessors: PredecessorResult[]
  /** Own output from the previous round, when this round was triggered by reprocessing. */
  previousOutput?: string
  /** Checkpoint feedback that triggered this round. */
  feedback?: string
  /** The checkpoint outcome that triggered this round. */
  reprocessReason?: string
}

export type NodeResult = {
  output?: string
  error?: string
  sessionID?: string
}

export interface NodeExecutor {
  execute(input: NodeExecution): Promise<NodeResult>
  cancel?(runId: string): Promise<void>
}

export type SchedulerEvent =
  | { type: "run-started" }
  | { type: "run-completed"; output: string }
  | { type: "run-failed"; error: string }
  | { type: "run-cancelled" }
  | { type: "node-queued"; nodeId: string; round: number }
  | { type: "node-started"; nodeId: string; round: number; attempt: number }
  | { type: "node-completed"; nodeId: string; round: number; output: string }
  | { type: "node-retrying"; nodeId: string; round: number; attempt: number; error: string }
  | { type: "node-failed"; nodeId: string; round: number; error: string }
  | { type: "edge-traversed"; edgeId: string; traversals: number; round: number }
  | {
      type: "checkpoint-waiting"
      nodeId: string
      round: number
      prompt: string
      options: CheckpointOption[]
    }
  | { type: "checkpoint-resolved"; nodeId: string; round: number; outcome: string; feedback?: string }

export class OrchestrationScheduler {
  private readonly graph: OrchestrationGraph
  private readonly input: string
  private readonly executor: NodeExecutor
  private readonly concurrency: number
  private readonly run: OrchestrationRun
  private readonly listeners = new Set<(event: SchedulerEvent) => void>()

  private active = 0
  private round = 0
  /** Node that seeds the current round (entry initially, reprocess target later). */
  private seed: string
  private rerunSet = new Set<string>()
  private waiting: { nodeId: string } | null = null
  private checkpointResolved = new Map<string, Set<number>>()
  private roundFeedback: { reason: string; feedback?: string } | undefined
  private terminal = false
  private aborted = false
  private advancing = false

  constructor(graph: OrchestrationGraph, input: string, executor: NodeExecutor, opts: { concurrency?: number } = {}) {
    this.graph = graph
    this.input = input
    this.executor = executor
    this.concurrency = opts.concurrency ?? 4
    this.run = createRun(graph, input)
    this.seed = graph.entryNodeId ?? ""
  }

  onEvent(listener: (event: SchedulerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): OrchestrationRun {
    return structuredClone(this.run)
  }

  async start(): Promise<void> {
    const issues = validateGraph(this.graph)
    if (issues.length > 0) {
      this.finishFailed(issues.map((issue) => issue.message).join("; "))
      return
    }
    if (!this.graph.entryNodeId) {
      this.finishFailed("No entry node is set")
      return
    }
    this.emit({ type: "run-started" })
    this.computeRerunSet()
    await this.advance()
  }

  /** Resolve a waiting checkpoint and continue the run. */
  async respond(nodeId: string, outcome: string, feedback?: string): Promise<void> {
    if (this.terminal || this.aborted) return
    if (this.waiting?.nodeId !== nodeId) return
    const checkpoint = nodeById(this.graph, nodeId)
    if (!checkpoint || !isCheckpointNode(checkpoint)) return
    this.waiting = null
    this.run.status = "running"

    const resolutions = this.run.checkpoints[nodeId] ?? []
    resolutions.push({ round: this.round, outcome, ...(feedback !== undefined ? { feedback } : {}) })
    this.run.checkpoints[nodeId] = resolutions
    this.run.updatedAt = Date.now()
    const rounds = this.checkpointResolved.get(nodeId) ?? new Set<number>()
    rounds.add(this.round)
    this.checkpointResolved.set(nodeId, rounds)
    this.emit({ type: "checkpoint-resolved", nodeId, round: this.round, outcome, ...(feedback ? { feedback } : {}) })

    // Route the chosen outcome through the checkpoint's outgoing edges.
    const chosen = checkpoint.options.length === 0 ? "" : outcome
    const edges = this.graph.edges.filter((edge) => {
      if (edge.from !== nodeId) return false
      if (checkpoint.options.length === 0) return !edge.route.outcome
      return edge.route.outcome === chosen
    })
    const reprocess = edges.find((edge) => edge.route.type === "reprocess")
    if (reprocess) {
      const limit = reprocess.route.maxTraversals ?? 0
      const traversals = this.run.edges[reprocess.id]?.traversals ?? 0
      if (traversals < limit) {
        this.traverseReprocess(reprocess, nodeId, outcome, feedback)
      } else if (reprocess.route.onLimit === "fail") {
        this.finishFailed(`The reprocessing loop limit (${limit}) was reached`)
        return
      } else if (reprocess.route.onLimit === "stop") {
        this.cancel()
        return
      }
      // onLimit "continue": fall through — forward edges with the chosen
      // outcome (if any) still fire in the current round.
    }
    await this.advance()
  }

  cancel(): void {
    if (this.terminal) return
    this.aborted = true
    void this.executor.cancel?.(this.run.id)
    this.finishCancelled()
  }

  // -------------------------------------------------------------------------
  // Scheduling loop
  // -------------------------------------------------------------------------

  private async advance(): Promise<void> {
    if (this.advancing) return
    this.advancing = true
    try {
      while (!this.terminal && !this.aborted) {
        if (this.run.status === "waiting-for-user") return

        let launched = 0
        while (this.active < this.concurrency) {
          const next = this.nextRunnable()
          if (!next) break
          if (isCheckpointNode(next.node)) {
            this.waitAtCheckpoint(next.node)
            return
          }
          launched++
          this.active++
          void this.launch(next.node, next.predecessors)
        }

        if (launched > 0) continue
        if (this.active > 0) return
        this.handlePassEnd()
        if (this.terminal || this.aborted) return
      }
    } finally {
      this.advancing = false
    }
  }

  private nextRunnable(): { node: OrchestrationNode; predecessors: PredecessorResult[] } | null {
    for (const node of this.graph.nodes) {
      if (isCheckpointNode(node)) continue
      if (this.nodeSatisfied(node)) continue
      if (!this.ready(node)) continue
      return { node, predecessors: this.predecessors(node) }
    }
    for (const node of this.graph.nodes) {
      if (!isCheckpointNode(node)) continue
      if (this.checkpointDone(node)) continue
      if (!this.ready(node)) continue
      return { node, predecessors: [] }
    }
    return null
  }

  private launch(node: OrchestrationNode, predecessors: PredecessorResult[]): void {
    if (!isAgentNode(node)) return
    const existing = this.runInRound(node.id, this.round)
    const run = existing ?? this.pushRun(node.id, "queued")
    if (!existing) this.emit({ type: "node-queued", nodeId: node.id, round: this.round })
    const execution: NodeExecution = {
      runId: this.run.id,
      nodeId: node.id,
      agentName: node.source.agentName,
      round: this.round,
      attempt: run.attempts,
      input: this.input,
      predecessors,
      ...(run.round > 0 ? { previousOutput: this.previousOutput(node.id, run.round) } : {}),
      ...(this.roundFeedback
        ? { feedback: this.roundFeedback.feedback, reprocessReason: this.roundFeedback.reason }
        : {}),
    }
    this.emit({ type: "node-started", nodeId: node.id, round: this.round, attempt: run.attempts })
    run.status = "running"
    run.startedAt = Date.now()
    this.run.updatedAt = Date.now()

    this.executor.execute(execution).then(
      (result) => this.complete(node, result),
      (err: unknown) => this.complete(node, { error: err instanceof Error ? err.message : String(err) }),
    )
  }

  private complete(node: AgentNode, result: NodeResult): void {
    this.active--
    const run = latestRun(this.run.nodes[node.id])
    if (!run || run.status === "cancelled" || this.terminal || this.aborted) return
    run.sessionID = result.sessionID
    run.finishedAt = Date.now()
    this.run.updatedAt = Date.now()

    if (result.error) {
      run.error = result.error
      const retries = node.runtime.retries ?? 0
      if (run.attempts <= retries) {
        run.attempts++
        run.status = "queued"
        this.emit({
          type: "node-retrying",
          nodeId: node.id,
          round: run.round,
          attempt: run.attempts,
          error: result.error,
        })
        this.active++
        void this.launch(node, this.predecessors(node))
        return
      }
      run.status = "failed"
      this.emit({ type: "node-failed", nodeId: node.id, round: run.round, error: result.error })
      if (node.runtime.failure === "stop") {
        this.finishFailed(`Node "${nodeLabel(node)}" failed: ${result.error}`)
        return
      }
      // continue: successors run and receive a labelled failure.
      void this.advance()
      return
    }

    run.status = "completed"
    run.output = result.output ?? ""
    this.emit({ type: "node-completed", nodeId: node.id, round: run.round, output: run.output })
    void this.advance()
  }

  // -------------------------------------------------------------------------
  // Readiness
  // -------------------------------------------------------------------------

  /** A node already has a terminal run for the current round (or is satisfied). */
  private nodeSatisfied(node: OrchestrationNode): boolean {
    const runs = this.run.nodes[node.id]
    if (!runs || runs.length === 0) return false
    const current = runInRound(runs, this.round)
    if (current) return true
    // Outside the re-run set, the latest run satisfies the node.
    return !this.rerunSet.has(node.id)
  }

  private runInRound(nodeId: string, round: number): NodeRun | undefined {
    return this.run.nodes[nodeId]?.find((run) => run.round === round)
  }

  private previousOutput(nodeId: string, round: number): string | undefined {
    const earlier = this.run.nodes[nodeId]?.find((run) => run.round === round - 1)
    return earlier?.status === "completed" ? earlier.output : undefined
  }

  private checkpointDone(node: CheckpointNode): boolean {
    const rounds = this.checkpointResolved.get(node.id)
    if (!rounds) return false
    if (rounds.has(this.round)) return true
    return !this.rerunSet.has(node.id)
  }

  private ready(node: OrchestrationNode): boolean {
    if (node.id === this.seed && !this.nodeSatisfied(node)) return true
    const incoming = this.graph.edges.filter((edge) => edge.to === node.id && edge.route.type === "forward")
    if (incoming.length === 0) return false
    return incoming.every((edge) => this.sourceSatisfied(edge))
  }

  private sourceSatisfied(edge: OrchestrationEdge): boolean {
    const source = nodeById(this.graph, edge.from)
    if (!source) return false
    if (isCheckpointNode(source)) return this.checkpointDone(source)
    const run = this.runInRound(source.id, this.round)
    if (run) return run.status === "completed" || run.status === "failed"
    return !this.rerunSet.has(source.id) && this.latestTerminal(source.id)
  }

  private latestTerminal(nodeId: string): boolean {
    const run = latestRun(this.run.nodes[nodeId])
    return !!run && (run.status === "completed" || run.status === "failed")
  }

  private predecessors(node: OrchestrationNode): PredecessorResult[] {
    const result: PredecessorResult[] = []
    for (const edge of this.graph.edges) {
      if (edge.to !== node.id || edge.route.type !== "forward") continue
      const source = nodeById(this.graph, edge.from)
      if (!source || isCheckpointNode(source)) continue
      const run = this.runInRound(source.id, this.round) ?? latestRun(this.run.nodes[source.id])
      if (!run) continue
      result.push({
        nodeId: source.id,
        label: nodeLabel(source),
        round: run.round,
        ...(run.status === "completed" ? { output: run.output } : { failed: true, error: run.error }),
      })
    }
    return result
  }

  // -------------------------------------------------------------------------
  // Pass / round transitions
  // -------------------------------------------------------------------------

  private waitAtCheckpoint(node: CheckpointNode): void {
    if (this.waiting) return
    this.waiting = { nodeId: node.id }
    this.run.status = "waiting-for-user"
    this.run.updatedAt = Date.now()
    this.emit({
      type: "checkpoint-waiting",
      nodeId: node.id,
      round: this.round,
      prompt: node.prompt,
      options: node.options,
    })
  }

  private handlePassEnd(): void {
    // A reprocessing edge from an agent node (no checkpoint outcome) fires at
    // the end of the pass, in edge order, while budget remains.
    for (const edge of this.graph.edges) {
      if (edge.route.type !== "reprocess") continue
      if (edge.route.outcome) continue // checkpoint-routed edges fire on respond()
      const source = nodeById(this.graph, edge.from)
      if (!source || isCheckpointNode(source)) continue
      const run = this.latestTerminalRun(source.id)
      if (!run || run.status !== "completed") continue
      const limit = edge.route.maxTraversals ?? 0
      const traversals = this.run.edges[edge.id]?.traversals ?? 0
      if (traversals < limit) {
        this.traverseReprocess(edge, edge.from, undefined, undefined)
        return
      }
      if (edge.route.onLimit === "fail") {
        this.finishFailed(`The reprocessing loop limit (${limit}) was reached`)
        return
      }
      if (edge.route.onLimit === "stop") {
        this.cancel()
        return
      }
    }
    this.finishCompleted()
  }

  private traverseReprocess(
    edge: OrchestrationEdge,
    reasonNodeId: string,
    reasonOutcome: string | undefined,
    feedback: string | undefined,
  ): void {
    const run = this.run.edges[edge.id]
    if (run) run.traversals++
    this.round++
    this.seed = edge.to
    this.computeRerunSet()
    this.roundFeedback = {
      reason: reasonOutcome ?? nodeLabel(nodeById(this.graph, reasonNodeId) ?? this.graph.nodes[0]!),
      ...(feedback !== undefined ? { feedback } : {}),
    }
    this.emit({ type: "edge-traversed", edgeId: edge.id, traversals: run?.traversals ?? 1, round: this.round })
    this.run.updatedAt = Date.now()
  }

  private computeRerunSet(): void {
    const seen = new Set<string>()
    const walk = (id: string): void => {
      if (seen.has(id)) return
      seen.add(id)
      for (const edge of this.graph.edges) {
        if (edge.from === id && edge.route.type === "forward") walk(edge.to)
      }
    }
    walk(this.seed)
    this.rerunSet = seen
  }

  // -------------------------------------------------------------------------
  // Terminal transitions
  // -------------------------------------------------------------------------

  private latestTerminalRun(nodeId: string): NodeRun | undefined {
    const run = latestRun(this.run.nodes[nodeId])
    return run && (run.status === "completed" || run.status === "failed") ? run : undefined
  }

  private finishCompleted(): void {
    if (this.terminal) return
    this.terminal = true
    this.run.status = "completed"
    this.run.updatedAt = Date.now()
    const output = this.selectOutput()
    this.run.output = output
    this.emit({ type: "run-completed", output })
  }

  private selectOutput(): string {
    const outputNode = this.graph.outputNodeId
    if (outputNode) {
      const run = this.latestTerminalRun(outputNode)
      return run?.status === "completed" ? (run.output ?? "") : ""
    }
    const terminals = this.graph.nodes.filter(
      (node) => !this.graph.edges.some((edge) => edge.from === node.id && edge.route.type === "forward"),
    )
    if (terminals.length === 1) {
      const run = this.latestTerminalRun(terminals[0]!.id)
      return run?.status === "completed" ? (run.output ?? "") : ""
    }
    return ""
  }

  private finishFailed(error: string): void {
    if (this.terminal) return
    this.terminal = true
    this.run.status = "failed"
    this.run.error = error
    this.run.updatedAt = Date.now()
    this.emit({ type: "run-failed", error })
  }

  private finishCancelled(): void {
    if (this.terminal) return
    this.terminal = true
    for (const runs of Object.values(this.run.nodes)) {
      const run = latestRun(runs)
      if (!run || (run.status !== "queued" && run.status !== "running")) continue
      run.status = "cancelled"
      run.finishedAt = Date.now()
    }
    this.run.status = "cancelled"
    this.run.updatedAt = Date.now()
    this.emit({ type: "run-cancelled" })
  }

  private pushRun(nodeId: string, status: NodeRun["status"]): NodeRun {
    const runs = this.run.nodes[nodeId] ?? []
    const run: NodeRun = { nodeId, round: this.round, status, attempts: 1 }
    runs.push(run)
    this.run.nodes[nodeId] = runs
    return run
  }

  private emit(event: SchedulerEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
