// kilocode_change - new file
// Builds the prompts delivered to a workflow node. The system prompt frames
// the agent as performing one node of a graph; the user prompt body carries
// the workflow input, predecessor results, iteration/feedback context, and the
// configured prompt-mode composition. Pure functions; no I/O.

import type { AgentNode } from "./domain"
import type { EffectiveAgent } from "./resolver"
import type { PredecessorResult } from "./scheduler"

const RUNTIME_HEADER = `You are running inside a deterministic workflow runtime. The graph—not you—decides which nodes run, in what order, with what dependencies. You are responsible for exactly this one node.

Rules:
- Do NOT call any agent / subagent / task tool. The runtime owns scheduling.
- Do NOT interpret the graph or pick a successor. Your only job is to do the work for THIS node and return the result.
- Do NOT coordinate with other nodes; their outputs are already in your context below.
- Return a self-contained result. Do not write to a global config or modify the source agent.
- If your task is unclear, say so in your final answer; the runtime will surface it to the user.`

export function buildSystemPrompt(effective: EffectiveAgent, node: AgentNode, iteration: number): string {
  const sections: string[] = [RUNTIME_HEADER]
  sections.push(
    `Node: ${effective.displayName} (source agent: ${effective.agentName})`,
    `Round: ${iteration}`,
  )
  if (effective.prompt.mode === "replace" && effective.prompt.text !== undefined) {
    sections.push(`Node instructions (replaces the source agent's prompt):\n\n${effective.prompt.text}`)
  } else if (effective.prompt.mode === "append" && effective.prompt.text) {
    const base = effective.prompt.source ? `Source agent prompt:\n\n${effective.prompt.source}\n\n` : ""
    sections.push(`${base}Node instructions (appended to the source agent's prompt):\n\n${effective.prompt.text}`)
  } else if (effective.prompt.source) {
    sections.push(`Source agent prompt:\n\n${effective.prompt.source}`)
  }
  return sections.join("\n\n")
}

export type PromptContext = {
  workflowInput: string
  node: AgentNode
  iteration: number
  attempt: number
  predecessors: PredecessorResult[]
  previousOutput?: string
  feedback?: string
  reprocessReason?: string
}

export function buildUserPrompt(ctx: PromptContext): string {
  const parts: string[] = []
  parts.push(`# Workflow input\n\n${ctx.workflowInput || "(none)"}`)

  if (ctx.predecessors.length > 0) {
    parts.push("# Predecessor results")
    for (const pre of ctx.predecessors) {
      const heading = pre.failed
        ? `## ${pre.label} (failed, round ${pre.round})`
        : `## ${pre.label} (round ${pre.round})`
      const body = pre.failed ? `Error: ${pre.error ?? "unknown"}` : (pre.output ?? "")
      parts.push(`${heading}\n\n${body}`)
    }
  }

  if (ctx.previousOutput) {
    parts.push(`# Your previous output (round ${ctx.iteration - 1})\n\n${ctx.previousOutput}`)
  }

  if (ctx.feedback || ctx.reprocessReason) {
    const reason = ctx.reprocessReason ? `Reason: ${ctx.reprocessReason}` : "Reason: previous round"
    const feedback = ctx.feedback ? `\nUser feedback:\n\n${ctx.feedback}` : ""
    parts.push(`# Reprocessing context\n\n${reason}${feedback}`)
  }

  parts.push(`# Output contract\n\nReturn your final result as plain text. The runtime records it as this node's output.`)
  return parts.join("\n\n")
}
