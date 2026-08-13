# Orchestration Page — V1 (UI/Canvas Editor + Publish-as-Agent)

## Goal

Add a new top-level **Orchestration** page to the Kilo VS Code extension where a user can visually compose a pipeline of agents/subagents (with skills and MCP servers attached as capabilities) and publish it as a selectable agent in Agent Manager's dropdown — without any changes to `packages/opencode` (the CLI). Execution of a published orchestration relies entirely on the CLI's existing `task` tool and the LLM following a generated delegation prompt; there is no deterministic graph runtime in this phase.

## Explicitly Out of Scope (this plan)

- Deterministic DAG execution engine, conditions, loops, human-input nodes, parallel/join scheduling.
- Run Inspector / token-cost telemetry per node.
- Individual MCP tool-level nodes (server-level only).
- Any change to `packages/opencode` source.
- Cycle detection / dependency validation beyond what's needed to generate a coherent prompt.

These are natural follow-ups; the data model below leaves room for them (see "Future-Proofing").

## Key Existing Building Blocks (grounding)

- Agent dropdown data source: `Agent.Service` in `packages/opencode/src/agent/agent.ts`, merging built-ins with `cfg.agent` config map. Already reachable from the extension via `session.agents()`/`session.allAgents()` (`webview-ui/src/context/session.tsx`), fed by `KiloProvider.fetchAndSendAgents()`.
- Skills: `session.skills()` context signal (via `requestSkills`/`skillsLoaded`), backed by `Skill.Service`.
- MCP servers: `session.mcpStatus()` context signal, backed by `ConfigMCPV1.Info` config (`mcp` top-level key) and `MCP.Service`.
- Config writes already flow through the existing SDK method `client.config.overlayUpdate({ scope, set, unset, directory, expected })` (used today by `ModeCreateView.tsx` to save custom agents) — **no new CLI endpoint needed** to publish a generated agent.
- Global config directory is discoverable via the existing SDK call `client.instance.path()` → returns `{ home, state, config, worktree, directory }` (`Global.Path.config` server-side). **No new CLI endpoint needed** to locate where to store orchestration graph files; the extension writes those files itself via Node `fs` since they are a Kilo-extension-only concept, not known to the CLI.
- No existing graph/canvas UI or graph library in the repo. `@xyflow/solid` will be a new dependency in `webview-ui`.
- The only multi-agent chaining primitive in the CLI is the `task` tool (parent/child session, `subagent_type`), gated by `subagent_depth` (default 1). Fictional names like `fx-arch-1` from prior research do not exist in this repo and are not part of this design.

## Data Model

New TypeScript types, e.g. `webview-ui/src/orchestration/types.ts` (or a shared location if reused extension-side):

```ts
type OrchestrationGraph = {
  id: string // slug, filename stem
  name: string
  version: 1
  entryNodeId: string | null // required before publish
  nodes: OrchestrationNode[]
  edges: OrchestrationEdge[] // agent -> agent only
  updatedAt: string // ISO
}

type OrchestrationNode = {
  id: string
  kind: "agent" | "subagent" // both reference an existing Agent.Service entry by name
  agentName: string
  position: { x: number; y: number }
  capabilities: {
    skills: string[] // skill names attached
    mcpServers: string[] // mcp server keys attached
  }
  // reserved for future execution phase, unused in v1:
  meta?: Record<string, unknown>
}

type OrchestrationEdge = {
  id: string
  from: string // node id
  to: string // node id
  // reserved for future branching semantics (e.g. condition), unused in v1
  meta?: Record<string, unknown>
}
```

Only `agent`/`subagent` nodes are connectable via edges (delegation order/fan-out/fan-in). Skill and MCP nodes are **not** part of `nodes`/`edges` as graph participants — dragging one from the palette onto/near an agent node mutates that agent node's `capabilities.skills` / `capabilities.mcpServers` array and renders as a small badge/chip on the node. They have no independent position or edges.

## Storage

- Location: `<config>/orchestration/<id>.json`, one file per graph, where `<config>` is resolved once per extension session via `client.instance.path()` (cache it; don't refetch per save).
- Directory created lazily via `fs.mkdir(dir, { recursive: true })`.
- List view reads all `*.json` in that directory (parse `name`/`updatedAt` for the gallery; tolerate parse errors per-file without crashing the list).
- Multi-graph gallery: New / Open / Rename / Duplicate / Delete, matching Agent Manager's existing list-of-worktrees UX conventions where reasonable (card layout, relative timestamps).

## Extension Surface (new files)

Mirrors the pattern already used by Agent Manager per `packages/kilo-vscode/AGENTS.md`.

1. **Build entry**: add a new esbuild entry point in `esbuild.js` for `orchestration` (extension-side Node/CJS + webview browser/IIFE), producing `dist/orchestration.js` alongside the existing Agent Manager entries.
2. **Extension provider**: `src/orchestration/OrchestrationProvider.ts` — registers a command (`kilo-code.new.orchestration` prefix per convention) that opens an editor tab (`retainContextWhenHidden: true`), reuses the shared `KiloConnectionService` for `client.instance.path()` and `client.config.overlayUpdate()`.
3. **File I/O helper**: `src/orchestration/graph-storage.ts` — list/read/write/delete graph JSON files under the resolved config dir, using Node `fs/promises`. Pure functions, easy to unit test without a real extension host.
4. **Message contracts**: `src/orchestration/types.ts` (extension↔webview messages: `orchestration.listGraphs`, `orchestration.loadGraph`, `orchestration.saveGraph`, `orchestration.deleteGraph`, `orchestration.duplicateGraph`, `orchestration.publishAsAgent`, plus their `*Result`/`*Loaded` responses), following the existing `ExtensionMessage`/`WebviewMessage` union pattern.
5. **package.json contributes**: new command entry, optional keybinding, optional menu item alongside the existing Agent Manager command registration point.

## Webview Surface (new files)

New top-level dir `webview-ui/orchestration/` (mirrors `webview-ui/agent-manager/`):

- `index.tsx` — webview entry point, provider hierarchy (`ThemeProvider → I18nProvider → DialogProvider → SessionProvider`-equivalent subset; reuse `session.tsx` context for agents/skills/MCP data since it already fetches exactly what the palette needs).
- `OrchestrationApp.tsx` — top-level router: gallery view vs. canvas-editor view for one open graph.
- `GraphGallery.tsx` — list/create/rename/duplicate/delete.
- `Canvas.tsx` — `@xyflow/solid` `<ReactFlow>`-equivalent wrapper, custom node renderer for agent nodes (shows name, mode, entry-star toggle, capability badges), edge renderer (simple bezier, arrow marker for direction).
- `ComponentPalette.tsx` — left rail, three sections (Agents/Subagents, Skills, MCP Servers) sourced from `session.allAgents()`, `session.skills()`, `session.mcpStatus()`; drag-source items.
- `NodeInspector.tsx` — right rail, shows selected node's agent details (read-only, since agent definitions themselves are edited in Agent Behaviour, not here) plus capability chip list with remove buttons.
- `Toolbar.tsx` — Save, Set Entry (only enabled with exactly one node selected), Publish as Agent (disabled until `entryNodeId` set and at least one node exists), zoom controls (delegated to Solid Flow controls where possible).
- `publish.ts` — pure function `buildAgentConfigFromGraph(graph): { name, mode: "primary", prompt, description }` that renders the delegation prompt (entry node, ordered edge list described as "delegate to X via the task tool", capability notes per node) — unit-testable without any UI.

## Publish-as-Agent Flow

1. User clicks **Publish as Agent** (enabled only when `entryNodeId` is set and graph has ≥1 node).
2. Webview posts `{ type: "orchestration.publishAsAgent", graphId }`.
3. Extension loads the graph, calls `publish.buildAgentConfigFromGraph(graph)`, then `client.config.overlayUpdate({ scope: "global", set: { agent: { [slug]: generatedConfig } } })` — same call path `ModeCreateView` already uses.
4. On success, extension triggers the existing agent-list refresh path (`fetchAndSendAgents()`) so the new agent shows up without a reload; surfaces a toast/confirmation in the webview.
5. Plan documents clearly (in a UI banner near the Publish button, and in code comments) that this generates a **prompt-driven delegation agent**, not a guaranteed sequential/parallel runtime — actual step order depends on the LLM following the generated prompt and issuing `task` calls itself, bounded by the CLI's existing `subagent_depth` limit.

## Validation Rules (v1, minimal)

- A node must reference a currently-known agent name (from `session.allAgents()`); if an agent was deleted after the graph was saved, render the node in an "unresolved" state and block Publish until fixed or removed.
- Exactly one node may be marked Entry; setting a new entry unmarks the previous one.
- No self-loop edges (node → itself). Multi-edge fan-out/fan-in is allowed (this is not a strict tree).
- No cycle detection beyond blocking a direct back-edge to the Entry node (cycles are otherwise allowed to reach the graph but will just make the generated prompt list a loopy delegation instruction — acceptable since there's no deterministic runtime yet to hang).

## Future-Proofing (not built now, but the schema/architecture must not block it)

- `meta` fields on nodes/edges reserved for: conditions, parallel-group ids, retry policy, run status.
- `publish.ts`'s pure prompt-builder is intentionally decoupled from the eventual "OrchestrationRuntime" — a later CLI-focused plan can introduce a real scheduler/tool without touching the canvas/editor code, by swapping what Publish does (e.g. writing a new kind of config entry, or calling a new CLI endpoint) while the graph data model stays valid.
- Storage format has a `version` field from day one for forward migrations.
- MCP node granularity (server-level) can later be split into per-tool nodes by extending `capabilities.mcpServers` into a richer shape without breaking existing saved graphs (add an optional `mcpTools?: Record<string, string[]>` alongside).

## Implementation Checklist

1. Add `@xyflow/solid` dependency to `webview-ui`.
2. Add esbuild entry + `package.json` command contribution for the new Orchestration tab.
3. Build `src/orchestration/graph-storage.ts` (list/read/write/delete) + unit tests (no VS Code API dependency).
4. Build `src/orchestration/OrchestrationProvider.ts` wiring messages to `graph-storage.ts` and `client.config.overlayUpdate`/`client.instance.path`.
5. Build webview `orchestration/` directory: gallery, canvas, palette, inspector, toolbar, per above.
6. Build `publish.ts` prompt generator + unit tests covering: linear chain, fan-out, fan-in, node with attached skills/MCP, missing-entry error case.
7. Wire capability drag-attach (skill/MCP palette item dropped onto/near an agent node mutates that node's `capabilities`).
8. Manual verification: create a 3-node graph (entry + 2 subagents), attach a skill and an MCP server to one node, Publish, confirm the new agent appears in Agent Manager's agent dropdown and in Agent Behaviour → Agents list.
9. Run `packages/kilo-vscode` checks: `bun run typecheck`, `bun run lint`, `bun run test:unit` (or `bun run test`), plus `bun run knip` since new exports are being added.

## Open Items for a Later (CLI-Focused) Plan

- Deterministic multi-agent execution engine (fan-out/fan-in guarantees, ordering enforcement, cycle detection, conditions/loops).
- Run Inspector with per-step status/tokens/cost.
- Per-tool MCP node granularity.
- Possible new CLI concept for "orchestration agent kind" if prompt-driven delegation proves insufficient.
