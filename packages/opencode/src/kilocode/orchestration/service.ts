import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { InvalidCheckpointError, InvalidGraphError, RunID, RunNotFoundError, Event } from "./api"
import type { OrchestrationGraph } from "./domain"
import { SessionNodeExecutor } from "./executor"
import { OrchestrationScheduler, type SchedulerEvent } from "./scheduler"
import type { OrchestrationRun } from "./state"
import { validateGraph } from "./validate"
import { Storage } from "@/storage/storage"

type Entry = { scheduler: OrchestrationScheduler; run: OrchestrationRun; pending: Promise<void> }
type State = { runs: Map<string, Entry>; saved: Map<string, OrchestrationRun> }

export interface Interface {
  readonly start: (input: {
    graph: OrchestrationGraph
    input: string
    concurrency?: number
  }) => Effect.Effect<OrchestrationRun, InvalidGraphError>
  readonly get: (runID: RunID) => Effect.Effect<OrchestrationRun, RunNotFoundError>
  readonly cancel: (runID: RunID) => Effect.Effect<OrchestrationRun, RunNotFoundError>
  readonly checkpoint: (input: {
    runID: RunID
    nodeId: string
    outcome: string
    feedback?: string
  }) => Effect.Effect<OrchestrationRun, RunNotFoundError | InvalidCheckpointError>
}

export class Service extends Context.Service<Service, Interface>()("@kilocode/Orchestration") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const bus = yield* Bus.Service
    const storage = yield* Storage.Service
    const state = yield* InstanceState.make<State>((ctx) =>
      Effect.gen(function* () {
        const keys = yield* storage.list(["orchestration", "run"])
        const saved = new Map<string, OrchestrationRun>()
        for (const key of keys) {
          const run = yield* storage.read<OrchestrationRun>(key).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!run || run.directory !== ctx.directory) continue
          if (run.status === "running" || run.status === "waiting-for-user") {
            run.status = "failed"
            run.error = "The CLI backend stopped before this orchestration run completed"
            run.waiting = undefined
            run.updatedAt = Date.now()
            run.revision++
            yield* storage.write(key, run)
          }
          saved.set(run.id, run)
        }
        return { runs: new Map(), saved }
      }).pipe(Effect.orDie),
    )

    const get = Effect.fn("Orchestration.get")(function* (runID: RunID) {
      const current = yield* InstanceState.get(state)
      const run = current.runs.get(runID)?.run ?? current.saved.get(runID)
      if (!run) return yield* new RunNotFoundError({ runID, message: `Orchestration run not found: ${runID}` })
      return structuredClone(run)
    })

    const update = Effect.fn("Orchestration.update")(function* (
      current: State,
      scheduler: OrchestrationScheduler,
      event: SchedulerEvent,
    ) {
      const run = scheduler.snapshot()
      const prior = current.runs.get(run.id)?.run ?? current.saved.get(run.id)
      run.directory = prior?.directory
      run.revision = (prior?.revision ?? 0) + 1
      if (event.type === "checkpoint-waiting") {
        run.waiting = {
          nodeId: event.nodeId,
          round: event.round,
          prompt: event.prompt,
          options: event.options,
          ...(event.title ? { title: event.title } : {}),
          ...(event.displayMode ? { displayMode: event.displayMode } : {}),
          ...(event.inputMode ? { inputMode: event.inputMode } : {}),
          ...(event.inputPlaceholder ? { inputPlaceholder: event.inputPlaceholder } : {}),
          ...(event.context ? { context: event.context } : {}),
        }
      } else if (event.type === "checkpoint-resolved") {
        run.waiting = undefined
      } else {
        run.waiting = prior?.waiting
      }
      current.saved.set(run.id, structuredClone(run))
      const id = RunID.make(run.id)
      const entry = current.runs.get(run.id)
      if (entry) entry.run = run
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
        current.runs.delete(run.id)
      }
      yield* storage.write(["orchestration", "run", run.id], run).pipe(Effect.orDie)
      yield* bus.publish(Event.Updated, {
        runID: id,
        revision: run.revision,
        event: event.type,
        status: run.status,
      })
    })

    const start: Interface["start"] = Effect.fn("Orchestration.start")(function* (input) {
      const list = yield* agents.list()
      const issues = validateGraph(
        input.graph,
        list.map((agent) => agent.name),
      )
      if (issues.length) return yield* new InvalidGraphError({ issues })
      const ctx = yield* InstanceState.context
      const bridge = yield* EffectBridge.make()
      const executor = new SessionNodeExecutor(input.graph, ctx)
      const scheduler = new OrchestrationScheduler(input.graph, input.input, executor, {
        concurrency: input.concurrency,
      })
      const current = yield* InstanceState.get(state)
      const run = scheduler.snapshot()
      run.directory = ctx.directory
      const id = RunID.make(run.id)
      const entry: Entry = { scheduler, run, pending: Promise.resolve() }
      current.runs.set(id, entry)
      current.saved.set(id, structuredClone(run))
      yield* storage.write(["orchestration", "run", run.id], run).pipe(Effect.orDie)
      const off = scheduler.onEvent((event) => {
        entry.pending = entry.pending.then(() => bridge.promise(update(current, scheduler, event)))
      })
      bridge.fork(Effect.promise(() => scheduler.start()).pipe(Effect.ensuring(Effect.sync(off))))
      return structuredClone(run)
    })

    const cancel: Interface["cancel"] = Effect.fn("Orchestration.cancel")(function* (runID) {
      const current = yield* InstanceState.get(state)
      const entry = current.runs.get(runID)
      if (!entry) return yield* get(runID)
      entry.scheduler.cancel()
      yield* Effect.promise(() => entry.pending)
      return yield* get(runID)
    })

    const checkpoint: Interface["checkpoint"] = Effect.fn("Orchestration.checkpoint")(function* (input) {
      const current = yield* InstanceState.get(state)
      const entry = current.runs.get(input.runID)
      if (!entry)
        return yield* new RunNotFoundError({
          runID: input.runID,
          message: `Orchestration run not found: ${input.runID}`,
        })
      const run = entry.run
      if (!run.waiting || run.waiting.nodeId !== input.nodeId) {
        return yield* new InvalidCheckpointError({
          runID: input.runID,
          message: "The run is not waiting at this checkpoint",
        })
      }
      if (!run.waiting.options.some((option) => option.id === input.outcome)) {
        return yield* new InvalidCheckpointError({ runID: input.runID, message: "Unknown checkpoint outcome" })
      }
      yield* Effect.promise(() => entry.scheduler.respond(input.nodeId, input.outcome, input.feedback))
      yield* Effect.promise(() => entry.pending)
      return yield* get(input.runID)
    })

    return Service.of({ start, get, cancel, checkpoint })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Agent.node, Bus.node, Storage.node] })

export * as Orchestration from "./service"
