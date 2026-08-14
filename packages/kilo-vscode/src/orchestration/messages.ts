// Extension <-> orchestration webview message contracts. Pure types, shared
// with the webview union in webview-ui/src/types/messages/orchestration.ts.
// Palette data (agents/skills/MCP) reuses the existing requestAgents /
// requestSkills / requestMcpStatus messages, so no new request types there.

import type { AgentRename, GraphSummary, OrchestrationGraph } from "./domain"
import type { OrchestrationStartResponse } from "@kilocode/sdk/v2"

export type OrchestrationRun = OrchestrationStartResponse

export type OrchestrationRequest =
  | { type: "orchestration.listGraphs" }
  | { type: "orchestration.loadGraph"; graphId: string }
  | { type: "orchestration.saveGraph"; graph: OrchestrationGraph; existing: boolean }
  | { type: "orchestration.deleteGraph"; graphId: string }
  | { type: "orchestration.duplicateGraph"; graphId: string }
  | { type: "orchestration.renameGraph"; graphId: string; name: string }
  | { type: "orchestration.publishAsAgent"; graphId: string }
  | { type: "orchestration.startRun"; graph: OrchestrationGraph; input: string }
  | { type: "orchestration.getRun"; runId: string }
  | { type: "orchestration.cancelRun"; runId: string }
  | { type: "orchestration.resolveCheckpoint"; runId: string; nodeId: string; outcome: string; feedback?: string }

export type OrchestrationResponse =
  | { type: "orchestration.ready"; vscodeLanguage: string; languageOverride?: string }
  | { type: "orchestration.graphs"; graphs: GraphSummary[] }
  | { type: "orchestration.graph"; graph: OrchestrationGraph }
  | { type: "orchestration.saved"; graph: OrchestrationGraph }
  | { type: "orchestration.agentsRenamed"; renames: AgentRename[] }
  | { type: "orchestration.deleted"; graphId: string }
  | { type: "orchestration.published"; agentName: string; slug: string }
  | { type: "orchestration.run"; run: OrchestrationRun }
  | { type: "orchestration.runEvent"; runId: string; revision: number }
  | { type: "orchestration.failed"; operation: string; message: string }
