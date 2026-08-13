import type { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { Question } from "@/question"
import type { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { binding, loadGraph } from "./binding"
import { SessionNodeExecutor } from "./executor"
import { OrchestrationScheduler, type SchedulerEvent } from "./scheduler"
import { validateGraph } from "./validate"

export function run(input: {
  agent: Agent.Info
  session: Session.Info
  user: SessionV1.User
  agents: Agent.Interface
  sessions: Session.Interface
  question: Question.Interface
  messages: SessionV1.WithParts[]
}) {
  return Effect.gen(function* () {
    const raw = input.agent.options.kiloOrchestration
    if (raw === undefined) return
    const ref = binding(raw)
    if (!ref) throw new Error(`Agent "${input.agent.name}" has an invalid orchestration binding`)
    const graph = yield* Effect.promise(() => loadGraph(ref.graph.id))
    const roster = yield* input.agents.list()
    const issues = validateGraph(graph, roster.map((agent) => agent.name))
    if (issues.length) throw new Error(issues.map((issue) => issue.message).join("; "))
    const ctx = yield* InstanceState.context
    const bridge = yield* EffectBridge.make()
    const executor = new SessionNodeExecutor(graph, ctx, { parentID: input.session.id })
    const user = input.messages.find((item) => item.info.id === input.user.id)
    const request = user?.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.synthetic)
      .map((part) => part.text)
      .join("\n") ?? ""
    const scheduler = new OrchestrationScheduler(graph, request, executor)
    const msg: SessionV1.Assistant = {
      id: MessageID.ascending(),
      sessionID: input.session.id,
      parentID: input.user.id,
      role: "assistant",
      mode: input.agent.name,
      agent: input.agent.name,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.user.model.modelID,
      providerID: input.user.model.providerID,
      path: { cwd: ctx.directory, root: ctx.worktree },
      time: { created: Date.now() },
    }
    yield* input.sessions.updateMessage(msg)
    const progress: SessionV1.TextPart = {
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: msg.sessionID,
      type: "text",
      text: `Running orchestration ${graph.name}`,
      synthetic: true,
    }
    yield* input.sessions.updatePart(progress)

    const result = yield* Effect.callback<{ output?: string; error?: string; cancelled?: boolean }, Error>((resume) => {
      const off = scheduler.onEvent((event) => {
        void update(event)
        if (event.type === "checkpoint-waiting") {
          void checkpoint(event)
          return
        }
        if (event.type === "run-completed") resume(Effect.succeed({ output: event.output }))
        if (event.type === "run-failed") resume(Effect.succeed({ error: event.error }))
        if (event.type === "run-cancelled") resume(Effect.succeed({ cancelled: true }))
      })
      void scheduler.start()
      async function update(event: SchedulerEvent) {
        progress.text = event.type.replaceAll("-", " ")
        await bridge.promise(input.sessions.updatePart(progress))
      }
      async function checkpoint(event: Extract<SchedulerEvent, { type: "checkpoint-waiting" }>) {
        const answers = await bridge.promise(
          input.question.ask({
            sessionID: input.session.id,
            blocking: true,
            questions: [
              {
                header: "Workflow",
                question: event.prompt,
                options: event.options.map((option) => ({ label: option.label, description: option.id })),
                multiple: false,
                custom: false,
              },
            ],
          }),
        ).catch(() => {
          scheduler.cancel()
          return []
        })
        const label = answers[0]?.[0]
        const option = event.options.find((item) => item.label === label)
        if (option) await scheduler.respond(event.nodeId, option.id)
      }
      return Effect.sync(() => {
        off()
        scheduler.cancel()
      })
    })
    const output = result.output ?? (result.cancelled ? "Orchestration cancelled" : `Orchestration failed: ${result.error}`)
    const final: SessionV1.TextPart = {
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: msg.sessionID,
      type: "text",
      text: output,
    }
    yield* input.sessions.updatePart(final)
    msg.finish = result.output !== undefined ? "stop" : "error"
    msg.time.completed = Date.now()
    yield* input.sessions.updateMessage(msg)
    return { info: msg, parts: [progress, final] }
  })
}

export * as KiloOrchestrationSession from "./session"
