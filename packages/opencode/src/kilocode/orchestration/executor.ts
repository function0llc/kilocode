import { Agent } from "@/agent/agent"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import type { InstanceContext } from "@/project/instance-context"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect } from "effect"
import { binding } from "./binding"
import { isAgentNode, nodeById, type AgentNode, type OrchestrationGraph } from "./domain"
import { registerAgent } from "./effective-agent"
import { buildSystemPrompt, buildUserPrompt } from "./prompt"
import { resolveNodeAgent, type EffectiveAgent } from "./resolver"
import type { NodeExecution, NodeExecutor, NodeResult } from "./scheduler"

type Options = {
  parentID?: Session.Info["id"]
  platform?: string
}

export function isVirtualEntry(graph: OrchestrationGraph, options: Record<string, unknown>): boolean {
  return binding(options.kiloOrchestration)?.graph.id === graph.id
}

export class SessionNodeExecutor implements NodeExecutor {
  private readonly sessions = new Map<string, Set<Session.Info["id"]>>()

  constructor(
    private readonly graph: OrchestrationGraph,
    private readonly ctx: InstanceContext,
    private readonly opts: Options = {},
  ) {}

  async execute(input: NodeExecution): Promise<NodeResult> {
    const node = nodeById(this.graph, input.nodeId)
    if (!node || !isAgentNode(node)) return { error: `Agent node not found: ${input.nodeId}` }

    return AppRuntime.runPromise(this.run(node, input).pipe(Effect.provideService(InstanceRef, this.ctx))).catch(
      (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
    )
  }

  async cancel(runID: string): Promise<void> {
    const ids = [...(this.sessions.get(runID) ?? [])]
    await Promise.all(
      ids.map((sessionID) =>
        AppRuntime.runPromise(
          SessionPrompt.Service.use((prompt) => prompt.cancel(sessionID)).pipe(
            Effect.provideService(InstanceRef, this.ctx),
          ),
        ),
      ),
    )
  }

  private run(node: AgentNode, input: NodeExecution) {
    const self = this
    return Effect.gen(function* () {
      const agents = yield* Agent.Service
      const provider = yield* Provider.Service
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const mcp = yield* MCP.Service
      const source = yield* agents.get(node.source.agentName)
      if (!source) return { error: `Agent not found: ${node.source.agentName}` }
      if (isVirtualEntry(self.graph, source.options)) return { output: input.input }
      yield* agents.guardRequirements(source)

      const fallback = yield* provider.defaultModel()
      const effective = resolveNodeAgent(node, { kind: "agent", agent: source }, fallback)
      const permission = capabilityRules(node, effective, Object.keys(yield* mcp.status()))
      const model = effective.model
        ? {
            providerID: ProviderV2.ID.make(effective.model.providerID),
            id: ModelV2.ID.make(effective.model.modelID),
            ...(effective.variant ? { variant: effective.variant } : {}),
          }
        : undefined
      const session = yield* sessions.create({
        parentID: self.opts.parentID,
        title: `${self.graph.name}: ${effective.displayName}`,
        agent: effective.agentName,
        model,
        permission,
        platform: self.opts.platform,
        metadata: {
          orchestration: {
            runID: input.runId,
            graphID: self.graph.id,
            nodeID: node.id,
            round: input.round,
            attempt: input.attempt,
          },
        },
      })
      self.track(input.runId, session.id)
      const resolved: Agent.Info = {
        ...source,
        name: effective.agentName,
        displayName: effective.displayName,
        description: effective.description,
        model: effective.model
          ? {
              providerID: ProviderV2.ID.make(effective.model.providerID),
              modelID: ModelV2.ID.make(effective.model.modelID),
            }
          : undefined,
        variant: effective.variant,
        prompt: undefined,
        temperature: effective.temperature,
        topP: effective.topP,
        steps: effective.steps,
        permission,
      }
      const unregister = registerAgent(session.id, resolved)
      const cleanup = Effect.sync(() => {
        unregister()
        self.untrack(input.runId, session.id)
      })
      const turn = prompt
        .prompt({
          sessionID: session.id,
          agent: effective.agentName,
          model: effective.model
            ? {
                providerID: ProviderV2.ID.make(effective.model.providerID),
                modelID: ModelV2.ID.make(effective.model.modelID),
              }
            : undefined,
          variant: effective.variant,
          system: buildSystemPrompt(effective, node, input.round),
          snapshotInitialization: "wait",
          parts: [
            {
              type: "text",
              text: buildUserPrompt({
                workflowInput: input.input,
                node,
                iteration: input.round,
                attempt: input.attempt,
                predecessors: input.predecessors,
                previousOutput: input.previousOutput,
                feedback: input.feedback,
                reprocessReason: input.reprocessReason,
              }),
            },
          ],
        })
      const result = yield* (node.runtime.timeoutMs
        ? turn.pipe(
            Effect.timeoutOrElse({
              duration: `${node.runtime.timeoutMs} millis`,
              orElse: () =>
                prompt.cancel(session.id).pipe(
                  Effect.andThen(Effect.die(new Error(`Node timed out after ${node.runtime.timeoutMs}ms`))),
                ),
            }),
            Effect.ensuring(cleanup),
          )
        : turn.pipe(Effect.ensuring(cleanup)))
      if (result.info.role !== "assistant") return { error: "Node execution did not produce an assistant response", sessionID: session.id }
      if (result.info.error) return { error: JSON.stringify(result.info.error), sessionID: session.id }
      const output = result.parts
        .filter((part): part is Extract<(typeof result.parts)[number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      return { output, sessionID: session.id }
    })
  }

  private track(runID: string, sessionID: Session.Info["id"]): void {
    const ids = this.sessions.get(runID) ?? new Set<Session.Info["id"]>()
    ids.add(sessionID)
    this.sessions.set(runID, ids)
  }

  private untrack(runID: string, sessionID: Session.Info["id"]): void {
    const ids = this.sessions.get(runID)
    ids?.delete(sessionID)
    if (ids?.size === 0) this.sessions.delete(runID)
  }
}

export function capabilityRules(node: AgentNode, effective: EffectiveAgent, servers: string[]) {
  const base = effective.permission.map((rule) => ({ ...rule, pattern: rule.pattern ?? "*" }))
  const skills = [
    { permission: "skill", pattern: "*", action: "deny" as const },
    ...node.capabilities.skills.map((name) => ({
      permission: "skill",
      pattern: name,
      action: Permission.evaluate("skill", name, base).action,
    })),
  ]
  const selected = new Set(node.capabilities.mcpServers)
  const mcp = servers
    .filter((server) => !selected.has(server))
    .flatMap((server) => [
      { permission: `${server.replace(/[^a-zA-Z0-9_-]/g, "_")}_*`, pattern: "*", action: "deny" as const },
      { permission: "read", pattern: `mcp:${server}:*`, action: "deny" as const },
    ])
  return [...base, ...skills, ...mcp]
}
