// kilocode_change - new file
import { describe, expect, it } from "bun:test"
import {
  coerceGraph,
  isAgentNode,
  type AgentNode,
  type CheckpointNode,
  type OrchestrationEdge,
  type OrchestrationGraph,
  type OrchestrationNode,
} from "../../../src/kilocode/orchestration/domain"
import {
  OrchestrationScheduler,
  type NodeExecution,
  type NodeExecutor,
  type NodeResult,
  type SchedulerEvent,
} from "../../../src/kilocode/orchestration/scheduler"
import { validateGraph } from "../../../src/kilocode/orchestration/validate"

function agent(id: string, name: string, runtime?: Partial<AgentNode["runtime"]>): OrchestrationNode {
  const node: AgentNode = {
    id,
    kind: "agent",
    source: { agentName: name },
    position: { x: 0, y: 0 },
    overrides: {},
    capabilities: { skills: [], mcpServers: [] },
    runtime: { retries: 0, failure: "stop", includeInFinalOutput: true, ...runtime },
  }
  return node
}

function checkpoint(id: string, prompt: string, options: Array<{ id: string; label: string }>): OrchestrationNode {
  const node: CheckpointNode = { id, kind: "checkpoint", position: { x: 0, y: 0 }, prompt, options }
  return node
}

function edge(id: string, from: string, to: string, route?: Partial<OrchestrationEdge["route"]>): OrchestrationEdge {
  return { id, from, to, route: { type: "forward", ...route } }
}

function graph(patch: Partial<OrchestrationGraph>): OrchestrationGraph {
  const base = coerceGraph({
    id: "g",
    name: "Test",
    nodes: [],
    edges: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  })!
  return { ...base, ...patch }
}

class FakeExecutor implements NodeExecutor {
  calls: NodeExecution[] = []
  private behaviors: Array<{ nodeId?: string; result: NodeResult; delay?: number }> = []

  add(nodeId: string | undefined, result: NodeResult, delay = 0): void {
    this.behaviors.push({ nodeId, result, delay })
  }

  execute(input: NodeExecution): Promise<NodeResult> {
    this.calls.push(input)
    const index = this.behaviors.findIndex((behavior) => !behavior.nodeId || behavior.nodeId === input.nodeId)
    const behavior = index >= 0 ? this.behaviors.splice(index, 1)[0] : undefined
    const result = behavior?.result ?? { output: `output-${input.nodeId}-${input.round}` }
    const delay = behavior?.delay ?? 0
    return new Promise((resolve) => setTimeout(() => resolve(result), delay))
  }
}

function eventsOf(scheduler: OrchestrationScheduler): { events: SchedulerEvent[]; wait: () => Promise<void> } {
  const events: SchedulerEvent[] = []
  let resolve: (() => void) | null = null
  let settled = false
  scheduler.onEvent((event) => {
    events.push(event)
    if (event.type === "run-completed" || event.type === "run-failed" || event.type === "run-cancelled") {
      settled = true
      resolve?.()
    }
  })
  return {
    events,
    wait: () =>
      new Promise<void>((done) => {
        if (settled) done()
        else resolve = done
      }),
  }
}

async function untilTerminal(scheduler: OrchestrationScheduler): Promise<SchedulerEvent[]> {
  const tracked = eventsOf(scheduler)
  await scheduler.start()
  await tracked.wait()
  return tracked.events
}

async function waitFor(
  scheduler: OrchestrationScheduler,
  pred: (snapshot: ReturnType<OrchestrationScheduler["snapshot"]>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (pred(scheduler.snapshot())) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("waitFor timed out")
}

describe("orchestration scheduler", () => {
  it("runs a linear graph in order", async () => {
    const executor = new FakeExecutor()
    const item = graph({
      entryNodeId: "a",
      nodes: [agent("a", "plan"), agent("b", "code"), agent("c", "review")],
      edges: [edge("e1", "a", "b"), edge("e2", "b", "c")],
    })
    const scheduler = new OrchestrationScheduler(item, "build the thing", executor)
    const events = await untilTerminal(scheduler)

    expect(scheduler.snapshot().status).toBe("completed")
    expect(executor.calls.map((call) => call.nodeId)).toEqual(["a", "b", "c"])
    expect(events.filter((event) => event.type === "run-completed")).toHaveLength(1)
    expect(scheduler.snapshot().output).toBe("output-c-0")
  })

  it("runs fan-out siblings concurrently and waits at the fan-in barrier", async () => {
    const executor = new FakeExecutor()
    executor.add("b", { output: "B" }, 30)
    executor.add("c", { output: "C" }, 30)
    const item = graph({
      entryNodeId: "a",
      nodes: [agent("a", "arch"), agent("b", "plan1"), agent("c", "plan2"), agent("d", "reconcile")],
      edges: [edge("e1", "a", "b"), edge("e2", "a", "c"), edge("e3", "b", "d"), edge("e4", "c", "d")],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    await untilTerminal(scheduler)

    const a = executor.calls.find((call) => call.nodeId === "a")!
    const b = executor.calls.find((call) => call.nodeId === "b")!
    const c = executor.calls.find((call) => call.nodeId === "c")!
    const d = executor.calls.find((call) => call.nodeId === "d")!
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(c).toBeDefined()
    expect(d).toBeDefined()

    // B and C started while A was still in flight? No — both started after A
    // completed, but their executions overlap each other.
    expect(d.round).toBe(0)
    expect(d.predecessors.map((p) => p.nodeId).sort()).toEqual(["b", "c"])
    expect(d.predecessors.find((p) => p.nodeId === "b")?.output).toBe("B")
    expect(d.predecessors.find((p) => p.nodeId === "c")?.output).toBe("C")
    expect(scheduler.snapshot().status).toBe("completed")
  })

  it("keeps sibling outputs isolated from each other", async () => {
    const executor = new FakeExecutor()
    const item = graph({
      entryNodeId: "a",
      nodes: [agent("a", "arch"), agent("b", "plan1"), agent("c", "plan2"), agent("d", "reconcile")],
      edges: [edge("e1", "a", "b"), edge("e2", "a", "c"), edge("e3", "b", "d"), edge("e4", "c", "d")],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    await untilTerminal(scheduler)

    const b = executor.calls.find((call) => call.nodeId === "b")!
    const c = executor.calls.find((call) => call.nodeId === "c")!
    expect(b.predecessors.map((p) => p.nodeId)).toEqual(["a"])
    expect(c.predecessors.map((p) => p.nodeId)).toEqual(["a"])
    expect(b.predecessors.some((p) => p.nodeId === "c")).toBe(false)
    expect(c.predecessors.some((p) => p.nodeId === "b")).toBe(false)
    // Both received A's output.
    expect(b.predecessors[0]?.output).toBe("output-a-0")
    expect(c.predecessors[0]?.output).toBe("output-a-0")
  })

  it("labels failed predecessors at the fan-in", async () => {
    const executor = new FakeExecutor()
    executor.add("b", { error: "boom" })
    const item = graph({
      entryNodeId: "a",
      nodes: [
        agent("a", "arch"),
        agent("b", "plan1", { failure: "continue" }),
        agent("c", "plan2"),
        agent("d", "reconcile"),
      ],
      edges: [edge("e1", "a", "b"), edge("e2", "a", "c"), edge("e3", "b", "d"), edge("e4", "c", "d")],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    await untilTerminal(scheduler)

    const d = executor.calls.find((call) => call.nodeId === "d")!
    const failed = d.predecessors.find((p) => p.nodeId === "b")
    expect(failed?.failed).toBe(true)
    expect(failed?.error).toBe("boom")
    expect(d.predecessors.find((p) => p.nodeId === "c")?.output).toBeDefined()
    expect(scheduler.snapshot().status).toBe("completed")
  })

  it("stops the run when a node with the stop policy fails", async () => {
    const executor = new FakeExecutor()
    executor.add("b", { error: "boom" })
    const item = graph({
      entryNodeId: "a",
      nodes: [agent("a", "arch"), agent("b", "plan")],
      edges: [edge("e1", "a", "b")],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    const events = await untilTerminal(scheduler)

    expect(scheduler.snapshot().status).toBe("failed")
    expect(scheduler.snapshot().error).toContain("boom")
    expect(events.some((event) => event.type === "run-failed")).toBe(true)
  })

  it("retries a node without consuming the reprocessing budget", async () => {
    const executor = new FakeExecutor()
    executor.add("a", { error: "first try" })
    executor.add("a", { output: "second try" })
    executor.add("b", { output: "B" })
    const item = graph({
      entryNodeId: "a",
      nodes: [agent("a", "plan", { retries: 1 }), agent("b", "code")],
      edges: [edge("e1", "a", "b")],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    await untilTerminal(scheduler)

    expect(scheduler.snapshot().status).toBe("completed")
    expect(executor.calls.filter((call) => call.nodeId === "a")).toHaveLength(2)
    const aRuns = scheduler.snapshot().nodes["a"]!
    expect(aRuns).toHaveLength(1)
    expect(aRuns[0]?.attempts).toBe(2)
    expect(aRuns[0]?.output).toBe("second try")
    // b saw the retried output
    const b = executor.calls.find((call) => call.nodeId === "b")!
    expect(b.predecessors[0]?.output).toBe("second try")
  })

  it("exhausts retries and continues when the policy says continue", async () => {
    const executor = new FakeExecutor()
    executor.add("a", { error: "nope" })
    executor.add("a", { error: "nope again" })
    executor.add("b", { output: "B" })
    const item = graph({
      entryNodeId: "a",
      nodes: [agent("a", "plan", { retries: 1, failure: "continue" }), agent("b", "code")],
      edges: [edge("e1", "a", "b")],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    await untilTerminal(scheduler)

    expect(scheduler.snapshot().status).toBe("completed")
    const b = executor.calls.find((call) => call.nodeId === "b")!
    expect(b.predecessors[0]?.failed).toBe(true)
  })

  it("waits at a checkpoint and routes the chosen outcome", async () => {
    const executor = new FakeExecutor()
    executor.add("d", { output: "D" })
    executor.add("e", { output: "E" })
    const item = graph({
      entryNodeId: "a",
      nodes: [
        agent("a", "plan"),
        agent("d", "reconcile"),
        checkpoint("cp", "OK?", [{ id: "accept", label: "Accept" }]),
        agent("e", "ship"),
      ],
      edges: [
        edge("e1", "a", "d"),
        edge("e2", "d", "cp"),
        { ...edge("e3", "cp", "e"), route: { type: "forward", outcome: "accept" } },
      ],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    const tracked = eventsOf(scheduler)
    await scheduler.start()
    await waitFor(scheduler, (snapshot) => snapshot.status === "waiting-for-user")

    expect(scheduler.snapshot().status).toBe("waiting-for-user")
    const waiting = tracked.events.find((event) => event.type === "checkpoint-waiting")
    expect(waiting?.type === "checkpoint-waiting" && waiting.options).toEqual([{ id: "accept", label: "Accept" }])

    await scheduler.respond("cp", "accept")
    await tracked.wait()
    expect(scheduler.snapshot().status).toBe("completed")
    expect(executor.calls.some((call) => call.nodeId === "e")).toBe(true)
    expect(scheduler.snapshot().checkpoints["cp"]?.[0]?.outcome).toBe("accept")
  })

  it("passes checkpoint decision as predecessor output to downstream nodes", async () => {
    const executor = new FakeExecutor()
    executor.add("d", { output: "D" })
    executor.add("e", { output: "E" })
    const item = graph({
      entryNodeId: "a",
      nodes: [
        agent("a", "plan"),
        agent("d", "reconcile"),
        checkpoint("cp", "OK?", [{ id: "accept", label: "Accept" }]),
        agent("e", "ship"),
      ],
      edges: [
        edge("e1", "a", "d"),
        edge("e2", "d", "cp"),
        { ...edge("e3", "cp", "e"), route: { type: "forward", outcome: "accept" } },
      ],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    const tracked = eventsOf(scheduler)
    await scheduler.start()
    await waitFor(scheduler, (snapshot) => snapshot.status === "waiting-for-user")

    await scheduler.respond("cp", "accept", "ship it")
    await tracked.wait()

    const e = executor.calls.find((call) => call.nodeId === "e")!
    expect(e.predecessors.length).toBe(1)
    expect(e.predecessors[0]!.label).toBe("User checkpoint")
    expect(e.predecessors[0]!.output).toContain("Accept")
    expect(e.predecessors[0]!.output).toContain("ship it")
  })

  it("emits checkpoint context when display mode is predecessors", async () => {
    const executor = new FakeExecutor()
    executor.add("d", { output: "D-output" })
    executor.add("e", { output: "E" })
    const item = graph({
      entryNodeId: "a",
      nodes: [
        agent("a", "plan"),
        agent("d", "reconcile"),
        {
          id: "cp",
          kind: "checkpoint",
          position: { x: 0, y: 0 },
          prompt: "OK?",
          options: [{ id: "accept", label: "Accept" }],
          display: { mode: "predecessors" },
          input: { mode: "optional" },
        } as CheckpointNode,
        agent("e", "ship"),
      ],
      edges: [
        edge("e1", "a", "d"),
        edge("e2", "d", "cp"),
        { ...edge("e3", "cp", "e"), route: { type: "forward", outcome: "accept" } },
      ],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    const tracked = eventsOf(scheduler)
    await scheduler.start()
    await waitFor(scheduler, (snapshot) => snapshot.status === "waiting-for-user")

    const waiting = tracked.events.find((event) => event.type === "checkpoint-waiting")
    expect(waiting?.type === "checkpoint-waiting").toBe(true)
    if (waiting?.type === "checkpoint-waiting") {
      expect(waiting.displayMode).toBe("predecessors")
      expect(waiting.context?.length).toBe(1)
      expect(waiting.context?.[0]?.label).toBe("reconcile")
      expect(waiting.context?.[0]?.output).toBe("D-output")
    }
    scheduler.cancel()
  })

  it("does not emit context when display mode is none", async () => {
    const executor = new FakeExecutor()
    executor.add("d", { output: "D-output" })
    executor.add("e", { output: "E" })
    const item = graph({
      entryNodeId: "a",
      nodes: [
        agent("a", "plan"),
        agent("d", "reconcile"),
        {
          id: "cp",
          kind: "checkpoint",
          position: { x: 0, y: 0 },
          prompt: "OK?",
          options: [{ id: "accept", label: "Accept" }],
          display: { mode: "none" },
          input: { mode: "none" },
        } as CheckpointNode,
        agent("e", "ship"),
      ],
      edges: [
        edge("e1", "a", "d"),
        edge("e2", "d", "cp"),
        { ...edge("e3", "cp", "e"), route: { type: "forward", outcome: "accept" } },
      ],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    const tracked = eventsOf(scheduler)
    await scheduler.start()
    await waitFor(scheduler, (snapshot) => snapshot.status === "waiting-for-user")

    const waiting = tracked.events.find((event) => event.type === "checkpoint-waiting")
    if (waiting?.type === "checkpoint-waiting") {
      expect(waiting.displayMode).toBe("none")
      expect(waiting.context).toBeUndefined()
      expect(waiting.inputMode).toBe("none")
    }
    scheduler.cancel()
  })

  it("reprocesses through a bounded loop and continues forward on acceptance", async () => {
    const executor = new FakeExecutor()
    const item = graph({
      entryNodeId: "a",
      nodes: [
        agent("a", "arch"),
        agent("b", "plan"),
        agent("c", "reconcile"),
        checkpoint("cp", "Happy?", [
          { id: "changes", label: "Request changes" },
          { id: "accept", label: "Accept" },
        ]),
        agent("d", "ship"),
      ],
      edges: [
        edge("e1", "a", "b"),
        edge("e2", "b", "c"),
        edge("e3", "c", "cp"),
        { ...edge("e4", "cp", "a"), route: { type: "reprocess", maxTraversals: 2, outcome: "changes" } },
        { ...edge("e5", "cp", "d"), route: { type: "forward", outcome: "accept" } },
      ],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    const tracked = eventsOf(scheduler)
    await scheduler.start()
    await waitFor(scheduler, (snapshot) => snapshot.status === "waiting-for-user")

    // Round 0 executes, checkpoint waits.
    expect(executor.calls.filter((call) => call.round === 0).map((call) => call.nodeId)).toEqual(["a", "b", "c"])
    expect(scheduler.snapshot().status).toBe("waiting-for-user")

    // Request changes once — round 1 re-executes from the entry with feedback.
    await scheduler.respond("cp", "changes", "too vague")
    await waitFor(scheduler, (snapshot) => snapshot.status === "waiting-for-user")
    expect(executor.calls.filter((call) => call.round === 1).map((call) => call.nodeId)).toEqual(["a", "b", "c"])
    const a1 = executor.calls.find((call) => call.nodeId === "a" && call.round === 1)!
    expect(a1.feedback).toBe("too vague")
    expect(a1.previousOutput).toBe("output-a-0")
    expect(scheduler.snapshot().status).toBe("waiting-for-user")

    // Accept — the forward route fires and the run completes.
    await scheduler.respond("cp", "accept")
    await tracked.wait()
    expect(scheduler.snapshot().status).toBe("completed")
    expect(executor.calls.some((call) => call.nodeId === "d")).toBe(true)
    expect(scheduler.snapshot().edges["e4"]?.traversals).toBe(1)
  })

  it("stops reprocessing at the traversal limit and applies the limit behavior", async () => {
    const executor = new FakeExecutor()
    const item = graph({
      entryNodeId: "a",
      nodes: [
        agent("a", "arch"),
        agent("b", "plan"),
        checkpoint("cp", "Happy?", [
          { id: "changes", label: "Request changes" },
          { id: "accept", label: "Accept" },
        ]),
        agent("d", "ship"),
      ],
      edges: [
        edge("e1", "a", "b"),
        edge("e2", "b", "cp"),
        {
          ...edge("e3", "cp", "a"),
          route: { type: "reprocess", maxTraversals: 1, onLimit: "fail", outcome: "changes" },
        },
        { ...edge("e4", "cp", "d"), route: { type: "forward", outcome: "accept" } },
      ],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    const tracked = eventsOf(scheduler)
    await scheduler.start()
    await waitFor(scheduler, (snapshot) => snapshot.status === "waiting-for-user")
    expect(scheduler.snapshot().status).toBe("waiting-for-user")

    await scheduler.respond("cp", "changes") // traversals 1 -> 1/1, round 1
    await waitFor(scheduler, (snapshot) => snapshot.status === "waiting-for-user")
    expect(scheduler.snapshot().status).toBe("waiting-for-user")
    expect(scheduler.snapshot().edges["e3"]?.traversals).toBe(1)

    await scheduler.respond("cp", "changes") // budget exhausted -> onLimit fail
    await tracked.wait()
    expect(scheduler.snapshot().status).toBe("failed")
    expect(scheduler.snapshot().error).toContain("loop limit")
    const rounds = scheduler.snapshot().nodes["a"]!.map((run) => run.round)
    expect(rounds).toEqual([0, 1])
  })

  it("applies onLimit continue by proceeding with forward routes", async () => {
    const executor = new FakeExecutor()
    executor.add("d", { output: "D" })
    const item = graph({
      entryNodeId: "a",
      nodes: [
        agent("a", "arch"),
        agent("b", "plan"),
        checkpoint("cp", "Happy?", [
          { id: "changes", label: "Request changes" },
          { id: "accept", label: "Accept" },
        ]),
        agent("d", "ship"),
      ],
      edges: [
        edge("e1", "a", "b"),
        edge("e2", "b", "cp"),
        {
          ...edge("e3", "cp", "a"),
          route: { type: "reprocess", maxTraversals: 1, onLimit: "continue", outcome: "changes" },
        },
        { ...edge("e4", "cp", "d"), route: { type: "forward", outcome: "accept" } },
      ],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    const tracked = eventsOf(scheduler)
    await scheduler.start()
    await waitFor(scheduler, (snapshot) => snapshot.status === "waiting-for-user")
    await scheduler.respond("cp", "changes")
    await waitFor(scheduler, (snapshot) => snapshot.status === "waiting-for-user")
    await scheduler.respond("cp", "changes") // exhausted -> continue: no forward route for "changes" -> run completes
    await tracked.wait()
    expect(scheduler.snapshot().status).toBe("completed")
    expect(scheduler.snapshot().edges["e3"]?.traversals).toBe(1)
  })

  it("fires agent-node reprocessing edges at pass end with a budget", async () => {
    const executor = new FakeExecutor()
    const item = graph({
      entryNodeId: "a",
      nodes: [agent("a", "arch"), agent("b", "review"), agent("c", "ship")],
      edges: [
        edge("e1", "a", "b"),
        edge("e2", "b", "c"),
        { ...edge("e3", "c", "a"), route: { type: "reprocess", maxTraversals: 1 } },
      ],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    await untilTerminal(scheduler)

    const runs = scheduler.snapshot().nodes["a"]!.map((run) => run.round)
    expect(runs).toEqual([0, 1])
    expect(scheduler.snapshot().edges["e3"]?.traversals).toBe(1)
    expect(scheduler.snapshot().status).toBe("completed")
  })

  it("cancels a run while parallel work is in flight", async () => {
    const executor = new FakeExecutor()
    executor.add("b", { output: "B" }, 50)
    executor.add("c", { output: "C" }, 50)
    const item = graph({
      entryNodeId: "a",
      outputNodeId: "c",
      nodes: [agent("a", "arch"), agent("b", "plan1"), agent("c", "plan2")],
      edges: [edge("e1", "a", "b"), edge("e2", "a", "c")],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    const tracked = eventsOf(scheduler)
    await scheduler.start()
    // Wait until both siblings are running, then cancel.
    await new Promise((resolve) => setTimeout(resolve, 10))
    scheduler.cancel()
    await tracked.wait()

    expect(scheduler.snapshot().status).toBe("cancelled")
    expect(scheduler.snapshot().nodes.b?.at(-1)?.status).toBe("cancelled")
    expect(scheduler.snapshot().nodes.c?.at(-1)?.status).toBe("cancelled")
    const terminal = tracked.events.filter(
      (event) => event.type === "run-completed" || event.type === "run-failed" || event.type === "run-cancelled",
    )
    expect(terminal).toHaveLength(1)
  })

  it("keeps concurrent runs on the same source agent independent", async () => {
    const executor = new FakeExecutor()
    const item = graph({
      entryNodeId: "a",
      nodes: [agent("a", "code"), agent("b", "review")],
      edges: [edge("e1", "a", "b")],
    })
    const first = new OrchestrationScheduler(item, "first request", executor)
    const second = new OrchestrationScheduler(item, "second request", executor)
    await Promise.all([untilTerminal(first), untilTerminal(second)])

    const inputs = first.snapshot().input
    expect(inputs).toBe("first request")
    expect(second.snapshot().input).toBe("second request")
    expect(executor.calls.some((call) => call.input === "first request")).toBe(true)
    expect(executor.calls.some((call) => call.input === "second request")).toBe(true)
  })

  it("rejects invalid graphs before executing anything", async () => {
    const executor = new FakeExecutor()
    const item = graph({
      entryNodeId: "a",
      nodes: [agent("a", "code"), agent("b", "review")],
      edges: [{ ...edge("e1", "b", "a") }],
    })
    const scheduler = new OrchestrationScheduler(item, "plan", executor)
    const events = await untilTerminal(scheduler)
    expect(scheduler.snapshot().status).toBe("failed")
    expect(executor.calls).toHaveLength(0)
    expect(events.some((event) => event.type === "run-failed")).toBe(true)
  })
})

describe("orchestration runtime validation", () => {
  it("flags multiple terminals without an output node", () => {
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [agent("a", "x"), agent("b", "y"), agent("c", "z")],
        edges: [edge("e1", "a", "b"), edge("e2", "a", "c")],
      }),
    )
    expect(issues.some((issue) => issue.code === "output-required")).toBe(true)
  })

  it("accepts a bounded reprocessing loop into the entry", () => {
    const issues = validateGraph(
      graph({
        entryNodeId: "a",
        nodes: [agent("a", "x"), agent("b", "y")],
        edges: [edge("e1", "a", "b"), { ...edge("e2", "b", "a"), route: { type: "reprocess", maxTraversals: 2 } }],
      }),
    )
    expect(issues).toEqual([])
  })

  it("coerces version 1 editor graphs", () => {
    const migrated = coerceGraph({
      id: "legacy",
      name: "Legacy",
      entryNodeId: "n1",
      nodes: [{ id: "n1", kind: "agent", agentName: "code", position: { x: 0, y: 0 }, capabilities: {} }],
      edges: [{ id: "e1", from: "n1", to: "n1" }],
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    expect(migrated).not.toBeNull()
    expect(migrated!.version).toBe(2)
    expect(isAgentNode(migrated!.nodes[0])).toBe(true)
    const first = migrated!.nodes[0]
    if (isAgentNode(first)) expect(first.source.agentName).toBe("code")
    expect(migrated!.edges[0].route).toEqual({ type: "forward" })
  })
})
