// kilocode_change - new file
// Orchestration graph contract for the CLI runtime. Mirrors the editor-side
// model in packages/kilo-vscode/src/orchestration/domain.ts (the extension is
// a separate package and cannot import from here). Stored graph JSON written
// by the editor is coerced to this shape, including in-memory migration of
// version 1 graphs.

export type OrchestrationGraph = {
  id: string
  name: string
  version: 2
  entryNodeId: string | null
  outputNodeId: string | null
  nodes: OrchestrationNode[]
  edges: OrchestrationEdge[]
  updatedAt: string
}

export type OrchestrationPermissionRule = {
  permission: string
  pattern?: string
  action: "allow" | "ask" | "deny"
}

export type PromptOverride = {
  mode: "inherit" | "append" | "replace"
  text?: string
}

export type NodeOverrides = {
  displayName?: string | null
  description?: string | null
  model?: { providerID: string; modelID: string } | null
  variant?: string | null
  prompt?: PromptOverride
  temperature?: number | null
  topP?: number | null
  steps?: number | null
  permission?: OrchestrationPermissionRule[]
}

export type NodeRuntime = {
  timeoutMs?: number
  retries?: number
  failure: "stop" | "continue"
  includeInFinalOutput?: boolean
}

export type AgentNode = {
  id: string
  kind: "agent"
  source: { agentName: string }
  position: { x: number; y: number }
  overrides: NodeOverrides
  capabilities: { skills: string[]; mcpServers: string[] }
  runtime: NodeRuntime
}

export type CheckpointOption = { id: string; label: string }

export type CheckpointNode = {
  id: string
  kind: "checkpoint"
  position: { x: number; y: number }
  prompt: string
  options: CheckpointOption[]
}

export type OrchestrationNode = AgentNode | CheckpointNode

export type EdgeRoute = {
  type: "forward" | "reprocess"
  outcome?: string
  maxTraversals?: number
  onLimit?: "continue" | "stop" | "fail"
}

export type OrchestrationEdge = {
  id: string
  from: string
  to: string
  route: EdgeRoute
}

export const DEFAULT_RUNTIME: NodeRuntime = {
  retries: 0,
  failure: "stop",
  includeInFinalOutput: true,
}

export function createId(prefix: string): string {
  const rand = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}_${rand.replace(/-/g, "").slice(0, 16)}`
}

export function isAgentNode(node: OrchestrationNode): node is AgentNode {
  return node.kind === "agent"
}

export function isCheckpointNode(node: OrchestrationNode): node is CheckpointNode {
  return node.kind === "checkpoint"
}

export function nodeLabel(node: OrchestrationNode): string {
  if (isCheckpointNode(node)) return "User checkpoint"
  return node.overrides.displayName || node.source.agentName
}

export function nodeById(graph: OrchestrationGraph, id: string): OrchestrationNode | undefined {
  return graph.nodes.find((node) => node.id === id)
}

export function edgeById(graph: OrchestrationGraph, id: string): OrchestrationEdge | undefined {
  return graph.edges.find((edge) => edge.id === id)
}

// ---------------------------------------------------------------------------
// Coercion / version migration (accepts editor-written JSON of either version)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function coercePosition(value: unknown): { x: number; y: number } {
  const raw = asRecord(value)
  return { x: Number(raw?.x) || 0, y: Number(raw?.y) || 0 }
}

function coerceOverrides(value: unknown): NodeOverrides {
  const raw = asRecord(value)
  if (!raw) return {}
  const out: NodeOverrides = {}
  if (typeof raw.displayName === "string" || raw.displayName === null) out.displayName = raw.displayName
  if (typeof raw.description === "string" || raw.description === null) out.description = raw.description
  const model = asRecord(raw.model)
  if (model && typeof model.providerID === "string" && typeof model.modelID === "string") {
    out.model = { providerID: model.providerID, modelID: model.modelID }
  } else if (raw.model === null) {
    out.model = null
  }
  if (typeof raw.variant === "string" || raw.variant === null) out.variant = raw.variant
  const prompt = asRecord(raw.prompt)
  if (prompt && (prompt.mode === "inherit" || prompt.mode === "append" || prompt.mode === "replace")) {
    out.prompt = { mode: prompt.mode, ...(typeof prompt.text === "string" ? { text: prompt.text } : {}) }
  }
  if (typeof raw.temperature === "number" || raw.temperature === null) out.temperature = raw.temperature
  if (typeof raw.topP === "number" || raw.topP === null) out.topP = raw.topP
  if (typeof raw.steps === "number" || raw.steps === null) out.steps = raw.steps
  if (Array.isArray(raw.permission)) {
    out.permission = raw.permission
      .map((item): OrchestrationPermissionRule | null => {
        const rule = asRecord(item)
        if (!rule || typeof rule.permission !== "string") return null
        const action = rule.action === "allow" || rule.action === "ask" || rule.action === "deny" ? rule.action : null
        if (!action) return null
        return {
          permission: rule.permission,
          ...(typeof rule.pattern === "string" ? { pattern: rule.pattern } : {}),
          action,
        }
      })
      .filter((rule): rule is OrchestrationPermissionRule => rule !== null)
  }
  return out
}

function coerceRuntime(value: unknown): NodeRuntime {
  const raw = asRecord(value)
  const out = { ...DEFAULT_RUNTIME }
  if (!raw) return out
  if (typeof raw.timeoutMs === "number" && raw.timeoutMs > 0) out.timeoutMs = raw.timeoutMs
  if (typeof raw.retries === "number" && raw.retries >= 0) out.retries = raw.retries
  if (raw.failure === "continue") out.failure = "continue"
  if (typeof raw.includeInFinalOutput === "boolean") out.includeInFinalOutput = raw.includeInFinalOutput
  return out
}

function coerceNode(value: unknown): OrchestrationNode | null {
  const raw = asRecord(value)
  if (!raw || typeof raw.id !== "string" || raw.id === "") return null
  const id = raw.id
  const position = coercePosition(raw.position)
  if (raw.kind === "checkpoint") {
    return {
      id,
      kind: "checkpoint",
      position,
      prompt: typeof raw.prompt === "string" ? raw.prompt : "",
      options: Array.isArray(raw.options)
        ? raw.options
            .map((item): CheckpointOption | null => {
              const option = asRecord(item)
              if (!option || typeof option.id !== "string" || typeof option.label !== "string") return null
              return { id: option.id, label: option.label }
            })
            .filter((option): option is CheckpointOption => option !== null)
        : [],
    }
  }
  const source = asRecord(raw.source)
  const capabilities = asRecord(raw.capabilities)
  const agentName =
    typeof source?.agentName === "string" ? source.agentName : typeof raw.agentName === "string" ? raw.agentName : ""
  return {
    id,
    kind: "agent",
    source: { agentName },
    position,
    overrides: coerceOverrides(raw.overrides),
    capabilities: {
      skills: Array.isArray(capabilities?.skills) ? capabilities.skills.map(String) : [],
      mcpServers: Array.isArray(capabilities?.mcpServers) ? capabilities.mcpServers.map(String) : [],
    },
    runtime: coerceRuntime(raw.runtime),
  }
}

function coerceRoute(value: unknown): EdgeRoute {
  const raw = asRecord(value)
  const route: EdgeRoute = { type: raw?.type === "reprocess" ? "reprocess" : "forward" }
  if (typeof raw?.outcome === "string") route.outcome = raw.outcome
  if (route.type === "reprocess") {
    if (typeof raw?.maxTraversals === "number" && raw.maxTraversals > 0) route.maxTraversals = raw.maxTraversals
    if (raw?.onLimit === "continue" || raw?.onLimit === "stop" || raw?.onLimit === "fail") {
      route.onLimit = raw.onLimit
    }
  }
  return route
}

function coerceEdge(value: unknown): OrchestrationEdge | null {
  const raw = asRecord(value)
  if (!raw || typeof raw.id !== "string" || typeof raw.from !== "string" || typeof raw.to !== "string") return null
  return { id: raw.id, from: raw.from, to: raw.to, route: coerceRoute(raw.route) }
}

export function coerceGraph(value: unknown): OrchestrationGraph | null {
  const raw = asRecord(value)
  if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string") return null
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null
  return {
    id: raw.id,
    name: raw.name,
    version: 2,
    entryNodeId: typeof raw.entryNodeId === "string" ? raw.entryNodeId : null,
    outputNodeId: typeof raw.outputNodeId === "string" ? raw.outputNodeId : null,
    nodes: raw.nodes.map(coerceNode).filter((node): node is OrchestrationNode => node !== null),
    edges: raw.edges.map(coerceEdge).filter((edge): edge is OrchestrationEdge => edge !== null),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
  }
}
