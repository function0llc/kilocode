import type { Agent } from "@/agent/agent"

const agents = new Map<string, Agent.Info>()

/** Register an invocation-local agent configuration for exactly one child session. */
export function registerAgent(sessionID: string, agent: Agent.Info): () => void {
  agents.set(sessionID, agent)
  return () => agents.delete(sessionID)
}

/** Resolve the invocation-local agent without touching global or project config. */
export function effectiveAgent(sessionID: string, fallback: Agent.Info): Agent.Info {
  return agents.get(sessionID) ?? fallback
}
