// Orchestration graph data model — pure domain logic shared by the extension
// (storage, publish) and the orchestration webview. No vscode or Node-only
// imports here so the webview bundle can import it safely.
//
// NOTE: unrelated to src/agent-manager/orchestration-*.ts, which coordinates
// worktree/session lifecycle. This module models a visual agent pipeline.
//
// Graph schema version 2 adds typed node kinds (agent / checkpoint), typed
// edge routes (forward / bounded reprocess), orchestration-local node
// overrides, and an explicit output node. Version 1 graphs are migrated in
// memory on load; files are rewritten as v2 only when the user saves.

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

/** undefined = inherit from the source agent; null = explicitly clear it. */
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

export type PromptOverride = {
  mode: "inherit" | "append" | "replace"
  text?: string
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
  capabilities: {
    skills: string[]
    mcpServers: string[]
  }
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
  /** Named checkpoint outcome this route follows (edges from checkpoints only). */
  outcome?: string
  /** Bound on how many times a reprocessing route may be traversed. */
  maxTraversals?: number
  onLimit?: "continue" | "stop" | "fail"
}

export type OrchestrationEdge = {
  id: string
  from: string
  to: string
  route: EdgeRoute
  meta?: {
    controls?: [{ x: number; y: number }, { x: number; y: number }]
  }
}

export type GraphSummary = {
  id: string
  name: string
  updatedAt: string
  nodes: number
}

export type OrchestrationAgentLike = {
  displayName?: string
  description?: string
  options?: Record<string, unknown>
}

export function isOrchestrationAgent(agent: OrchestrationAgentLike | null | undefined): boolean {
  const value = agent?.options?.kiloOrchestration
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const binding = value as Record<string, unknown>
  if (binding.version !== 2 || !binding.graph || typeof binding.graph !== "object" || Array.isArray(binding.graph)) {
    return false
  }
  const graph = binding.graph as Record<string, unknown>
  return typeof graph.id === "string" && graph.id.length > 0 && graph.scope === "global"
}

export function orchestrationAgentName(agent: OrchestrationAgentLike): string | undefined {
  if (!isOrchestrationAgent(agent)) return undefined
  if (agent.displayName) return agent.displayName
  return agent.description?.match(/^Deterministic orchestration "(.+)"$/)?.[1]
}

/** Structured validation issue so the canvas and inspector can highlight the source. */
export type GraphIssue = {
  code: string
  message: string
  nodeId?: string
  edgeId?: string
}

export const NODE_WIDTH = 184
export const NODE_HEIGHT = 72

export const DEFAULT_RUNTIME: NodeRuntime = {
  retries: 0,
  failure: "stop",
  includeInFinalOutput: true,
}

export function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "")
  if (!slug) return "orchestration"
  return /^[a-z]/.test(slug) ? slug : `orchestration-${slug}`
}

export function createId(prefix: string): string {
  const rand = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}_${rand.replace(/-/g, "").slice(0, 16)}`
}

export function createGraph(name: string): OrchestrationGraph {
  return {
    id: slugify(name),
    name,
    version: 2,
    entryNodeId: null,
    outputNodeId: null,
    nodes: [],
    edges: [],
    updatedAt: new Date().toISOString(),
  }
}

export function createAgentNode(id: string, agentName: string, position: { x: number; y: number }): AgentNode {
  return {
    id,
    kind: "agent",
    source: { agentName },
    position,
    overrides: {},
    capabilities: { skills: [], mcpServers: [] },
    runtime: { ...DEFAULT_RUNTIME },
  }
}

export function createCheckpointNode(id: string, position: { x: number; y: number }): CheckpointNode {
  return {
    id,
    kind: "checkpoint",
    position,
    prompt: "",
    options: [],
  }
}

export function createEdge(id: string, from: string, to: string): OrchestrationEdge {
  return { id, from, to, route: { type: "forward" } }
}

export function summarize(graph: OrchestrationGraph): GraphSummary {
  return { id: graph.id, name: graph.name, updatedAt: graph.updatedAt, nodes: graph.nodes.length }
}

export function nodeById(graph: OrchestrationGraph, id: string): OrchestrationNode | undefined {
  return graph.nodes.find((node) => node.id === id)
}

export function isAgentNode(node: OrchestrationNode): node is AgentNode {
  return node.kind === "agent"
}

export function isCheckpointNode(node: OrchestrationNode): node is CheckpointNode {
  return node.kind === "checkpoint"
}

/** Display name: node override wins over the source agent name. */
export function nodeLabel(node: OrchestrationNode): string {
  if (isCheckpointNode(node)) return "User checkpoint"
  return node.overrides.displayName || node.source.agentName
}

/** Why two nodes cannot be connected, or null when the edge is allowed. */
export function connectError(graph: OrchestrationGraph, from: string, to: string): string | null {
  if (from === to) return "A node cannot connect to itself"
  if (!nodeById(graph, from) || !nodeById(graph, to)) return "Unknown node"
  if (graph.edges.some((edge) => edge.from === from && edge.to === to)) return "Already connected"
  return null
}

// ---------------------------------------------------------------------------
// Coercion / version migration
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function coercePosition(value: unknown): { x: number; y: number } {
  const raw = asRecord(value)
  return { x: Number(raw?.x) || 0, y: Number(raw?.y) || 0 }
}

function coerceStringOrNull(value: unknown): string | null | undefined {
  if (typeof value === "string" || value === null) return value
  return undefined
}

function coerceNumberOrNull(value: unknown): number | null | undefined {
  if (typeof value === "number" || value === null) return value
  return undefined
}

function coerceModel(value: unknown): NodeOverrides["model"] {
  const raw = asRecord(value)
  if (raw && typeof raw.providerID === "string" && typeof raw.modelID === "string") {
    return { providerID: raw.providerID, modelID: raw.modelID }
  }
  return value === null ? null : undefined
}

function coercePrompt(value: unknown): PromptOverride | undefined {
  const raw = asRecord(value)
  if (!raw || (raw.mode !== "inherit" && raw.mode !== "append" && raw.mode !== "replace")) return undefined
  return {
    mode: raw.mode,
    ...(typeof raw.text === "string" ? { text: raw.text } : {}),
  }
}

function coercePermissionRule(value: unknown): OrchestrationPermissionRule | null {
  const rule = asRecord(value)
  if (!rule || typeof rule.permission !== "string") return null
  const action = rule.action === "allow" || rule.action === "ask" || rule.action === "deny" ? rule.action : null
  if (!action) return null
  return {
    permission: rule.permission,
    ...(typeof rule.pattern === "string" ? { pattern: rule.pattern } : {}),
    action,
  }
}

function coerceOverrides(value: unknown): NodeOverrides {
  const raw = asRecord(value)
  if (!raw) return {}
  const out: NodeOverrides = {}
  const displayName = coerceStringOrNull(raw.displayName)
  if (displayName !== undefined) out.displayName = displayName
  const description = coerceStringOrNull(raw.description)
  if (description !== undefined) out.description = description
  const model = coerceModel(raw.model)
  if (model !== undefined) out.model = model
  const variant = coerceStringOrNull(raw.variant)
  if (variant !== undefined) out.variant = variant
  const prompt = coercePrompt(raw.prompt)
  if (prompt !== undefined) out.prompt = prompt
  const temperature = coerceNumberOrNull(raw.temperature)
  if (temperature !== undefined) out.temperature = temperature
  const topP = coerceNumberOrNull(raw.topP)
  if (topP !== undefined) out.topP = topP
  const steps = coerceNumberOrNull(raw.steps)
  if (steps !== undefined) out.steps = steps
  if (Array.isArray(raw.permission)) {
    out.permission = raw.permission
      .map(coercePermissionRule)
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

function coerceCapabilities(value: unknown): AgentNode["capabilities"] {
  const raw = asRecord(value)
  return {
    skills: Array.isArray(raw?.skills) ? raw.skills.map(String) : [],
    mcpServers: Array.isArray(raw?.mcpServers) ? raw.mcpServers.map(String) : [],
  }
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

  // Agent node. v2 stores the reference under `source`; v1 stored it at the
  // top level as `agentName`. Both are accepted here.
  const source = asRecord(raw.source)
  const agentName =
    typeof source?.agentName === "string" ? source.agentName : typeof raw.agentName === "string" ? raw.agentName : ""
  return {
    id,
    kind: "agent",
    source: { agentName },
    position,
    overrides: coerceOverrides(raw.overrides),
    capabilities: coerceCapabilities(raw.capabilities),
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
  const meta = asRecord(raw.meta)
  const controls = Array.isArray(meta?.controls)
    ? meta.controls.map(asRecord).filter((point) => typeof point?.x === "number" && typeof point?.y === "number")
    : []
  return {
    id: raw.id,
    from: raw.from,
    to: raw.to,
    route: coerceRoute(raw.route),
    ...(controls.length === 2
      ? {
          meta: {
            controls: [
              { x: controls[0]!.x as number, y: controls[0]!.y as number },
              { x: controls[1]!.x as number, y: controls[1]!.y as number },
            ],
          },
        }
      : {}),
  }
}

/**
 * Tolerantly parse stored graph JSON of any supported version, migrating v1
 * shapes to v2 in memory. Returns null when the value is unusable.
 */
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateEdge(
  issues: GraphIssue[],
  graph: OrchestrationGraph,
  ids: Set<string>,
  checkpoints: Map<string, CheckpointNode>,
  edge: OrchestrationEdge,
): void {
  if (edge.from === edge.to) {
    issues.push({ code: "self-loop", message: "A node cannot connect to itself", edgeId: edge.id })
  }
  if (!ids.has(edge.from) || !ids.has(edge.to)) {
    issues.push({ code: "dangling-edge", message: "A connection references a missing node", edgeId: edge.id })
    return
  }

  const fromCheckpoint = checkpoints.get(edge.from)
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

  if (fromCheckpoint && fromCheckpoint.options.length > 0 && !edge.route.outcome) {
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
  if (
    fromCheckpoint &&
    edge.route.outcome &&
    !fromCheckpoint.options.some((option) => option.id === edge.route.outcome)
  ) {
    issues.push({
      code: "checkpoint-outcome-unknown",
      message: `The outcome "${edge.route.outcome}" is not one of the checkpoint's options`,
      edgeId: edge.id,
    })
  }
}

function collectNodes(
  issues: GraphIssue[],
  graph: OrchestrationGraph,
  ids: Set<string>,
  checkpoints: Map<string, CheckpointNode>,
  agents: Set<string> | undefined,
): void {
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
}

/**
 * Validate a graph for saving/publishing/running. Returns structured issues;
 * an empty list means the graph is coherent. `knownAgents` may be omitted
 * while the roster is still loading, which skips the unknown-agent check.
 */
export function validateGraph(graph: OrchestrationGraph, knownAgents?: Iterable<string>): GraphIssue[] {
  const issues: GraphIssue[] = []
  const ids = new Set<string>()
  const checkpoints = new Map<string, CheckpointNode>()
  const agents = knownAgents ? new Set(knownAgents) : undefined

  if (graph.nodes.length === 0) {
    issues.push({ code: "empty", message: "The graph has no nodes" })
  }

  collectNodes(issues, graph, ids, checkpoints, agents)

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

  // Ambiguous routing: two edges from the same checkpoint sharing one outcome.
  const seenOutcomes = new Map<string, Set<string>>()
  for (const edge of graph.edges) {
    const checkpoint = checkpoints.get(edge.from)
    if (!checkpoint) continue
    const outcome = edge.route.outcome ?? ""
    const seen = seenOutcomes.get(edge.from) ?? new Set<string>()
    if (seen.has(outcome)) {
      issues.push({
        code: "duplicate-outcome",
        message: `Multiple connections for the same checkpoint outcome`,
        edgeId: edge.id,
      })
    }
    seen.add(outcome)
    seenOutcomes.set(edge.from, seen)
  }

  // Every checkpoint outcome should lead somewhere.
  for (const checkpoint of checkpoints.values()) {
    for (const option of checkpoint.options) {
      const routed = graph.edges.some((edge) => edge.from === checkpoint.id && edge.route.outcome === option.id)
      if (!routed) {
        issues.push({
          code: "checkpoint-option-orphaned",
          message: `The "${option.label}" outcome has no outgoing connection`,
          nodeId: checkpoint.id,
        })
      }
    }
  }

  findForwardCycles(issues, graph)
  findUnreachable(issues, graph, ids)

  // Multiple terminal nodes need an explicit output selection.
  const terminal = graph.nodes.filter(
    (node) => !graph.edges.some((edge) => edge.from === node.id && edge.route.type === "forward"),
  )
  if (terminal.length > 1 && !graph.outputNodeId) {
    issues.push({
      code: "output-required",
      message: "The graph has multiple terminal nodes; set an output node",
    })
  }

  return issues
}

// Forward edges must not form cycles — only bounded reprocessing edges may
// loop back. DFS flags the first back edge it finds.
function findForwardCycles(issues: GraphIssue[], graph: OrchestrationGraph): void {
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
}

// Every node must be reachable from the entry (forward or reprocess edges).
function findUnreachable(issues: GraphIssue[], graph: OrchestrationGraph, ids: Set<string>): void {
  if (!graph.entryNodeId || !ids.has(graph.entryNodeId)) return
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
