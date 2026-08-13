// kilocode_change - new file
// Pure effective-agent resolution. Combines a source Agent.Info with
// orchestration node overrides to produce the configuration actually used at
// runtime. Never mutates the source agent or any global/project configuration.

import type { AgentNode, NodeOverrides, NodeRuntime } from "./domain"

export type ResolvedModel = { providerID: string; modelID: string }

export type ResolvedPermissions = Array<{ permission: string; pattern?: string; action: "allow" | "ask" | "deny" }>

/** Effective agent configuration produced by the resolver. */
export type EffectiveAgent = {
  agentName: string
  displayName: string
  description?: string
  model?: ResolvedModel
  variant?: string
  prompt: { source?: string; mode: "inherit" | "append" | "replace"; text?: string }
  temperature?: number
  topP?: number
  steps?: number
  permission: ResolvedPermissions
}

export type SourceAgentLike = {
  name: string
  displayName?: string
  description?: string
  model?: { providerID: string; modelID: string } | null
  variant?: string | null
  prompt?: string
  temperature?: number | null
  topP?: number | null
  steps?: number | null
  permission?: ResolvedPermissions
}

/** Sentinel for "no agent found" callers. The resolver never throws. */
export type ResolverSource = { kind: "agent"; agent: SourceAgentLike } | { kind: "missing"; reason: string }

/**
 * Resolve a node into an effective configuration. Resolution order is:
 *
 *   1. source agent fields are the defaults
 *   2. node overrides take precedence; `null` clears an inherited optional value
 *   3. node runtime supplies steps/retries/failure policy
 *   4. node displayName/description override the source labels
 *
 * The source agent is never mutated.
 */
export function resolveNodeAgent(node: AgentNode, source: ResolverSource, defaultModel?: ResolvedModel): EffectiveAgent {
  const promptMode = node.overrides.prompt?.mode ?? "inherit"
  const overrideText = node.overrides.prompt?.text
  const sourcePrompt = source.kind === "agent" ? source.agent.prompt : undefined

  const prompt: EffectiveAgent["prompt"] =
    promptMode === "replace"
      ? { mode: "replace", ...(overrideText !== undefined ? { text: overrideText } : {}) }
      : promptMode === "append"
        ? {
            mode: "append",
            ...(sourcePrompt ? { source: sourcePrompt } : {}),
            ...(overrideText ? { text: overrideText } : {}),
          }
        : sourcePrompt
          ? { mode: "inherit", source: sourcePrompt }
          : { mode: "inherit" }

  const fallbackName = source.kind === "agent" ? source.agent.name : node.source.agentName
  const displayName = node.overrides.displayName ?? sourceFallback(source, "displayName") ?? fallbackName
  const description = descriptionOrUndefined(node, source)
  const model = resolveModel(node, source, defaultModel)
  const variant = resolveVariant(node, source)
  const temperature = resolveNumber(node.overrides.temperature, sourceField(source, "temperature"))
  const topP = resolveNumber(node.overrides.topP, sourceField(source, "topP"))
  const steps = resolveNumber(node.overrides.steps, sourceField(source, "steps"))

  return {
    agentName: fallbackName,
    displayName,
    ...(description !== undefined ? { description } : {}),
    ...(model ? { model } : {}),
    ...(variant !== undefined ? { variant } : {}),
    prompt,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(steps !== undefined ? { steps } : {}),
    permission: resolvePermissions(node, source),
  }
}

function descriptionOrUndefined(node: AgentNode, source: ResolverSource): string | undefined {
  if (node.overrides.description === null) return undefined
  if (typeof node.overrides.description === "string") return node.overrides.description
  if (source.kind === "agent") return source.agent.description
  return undefined
}

function resolveModel(
  node: AgentNode,
  source: ResolverSource,
  defaultModel?: ResolvedModel,
): ResolvedModel | undefined {
  if (node.overrides.model) return node.overrides.model
  if (node.overrides.model === null) return undefined
  if (source.kind === "agent" && source.agent.model) return source.agent.model
  return defaultModel
}

function resolveVariant(node: AgentNode, source: ResolverSource): string | undefined {
  if (node.overrides.variant === null) return undefined
  if (typeof node.overrides.variant === "string") return node.overrides.variant
  if (source.kind === "agent" && source.agent.variant) return source.agent.variant
  return undefined
}

function resolveNumber(override: number | null | undefined, source: number | null | undefined): number | undefined {
  if (typeof override === "number") return override
  if (override === null) return undefined
  if (typeof source === "number") return source
  return undefined
}

function resolvePermissions(node: AgentNode, source: ResolverSource): ResolvedPermissions {
  if (node.overrides.permission) return node.overrides.permission
  if (source.kind === "agent" && source.agent.permission) return source.agent.permission
  return []
}

function sourceFallback(source: ResolverSource, field: keyof SourceAgentLike): string | undefined {
  if (source.kind !== "agent") return undefined
  const v = source.agent[field]
  return typeof v === "string" ? v : undefined
}

function sourceField(source: ResolverSource, field: "temperature" | "topP" | "steps"): number | null | undefined {
  if (source.kind !== "agent") return undefined
  return source.agent[field] as number | null | undefined
}

/** Runtime parameters surfaced separately so the executor can wire them in. */
export type ResolvedRuntime = {
  timeoutMs?: number
  retries: number
  failure: "stop" | "continue"
  includeInFinalOutput: boolean
}

export function resolveRuntime(runtime: NodeRuntime): ResolvedRuntime {
  return {
    ...(runtime.timeoutMs ? { timeoutMs: runtime.timeoutMs } : {}),
    retries: runtime.retries ?? 0,
    failure: runtime.failure,
    includeInFinalOutput: runtime.includeInFinalOutput ?? true,
  }
}
