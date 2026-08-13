import { nodeById, slugify, type OrchestrationGraph } from "./domain"

export type PublishedAgentConfig = {
  mode: "primary"
  description: string
  prompt: null
  options: {
    kiloOrchestration: {
      version: 2
      graph: { id: string; scope: "global" }
    }
  }
}

export type PublishResult = { slug: string; config: PublishedAgentConfig }
export class PublishError extends Error {}

export function buildAgentConfigFromGraph(graph: OrchestrationGraph): PublishResult {
  if (graph.nodes.length === 0) throw new PublishError("Cannot publish an empty graph")
  if (!graph.entryNodeId) throw new PublishError("Set an entry node before publishing")
  if (!nodeById(graph, graph.entryNodeId)) throw new PublishError("The entry node no longer exists")
  return {
    slug: slugify(graph.name),
    config: {
      mode: "primary",
      description: `Deterministic orchestration "${graph.name}"`,
      prompt: null,
      options: {
        kiloOrchestration: { version: 2, graph: { id: graph.id, scope: "global" } },
      },
    },
  }
}
