import type { KiloClient } from "@kilocode/sdk/v2"
import { nodeById, slugify, type OrchestrationGraph } from "./domain"

export type PublishedAgentConfig = {
  mode: "primary"
  displayName: string
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

type ConfigLike = {
  agent?: Record<string, { options?: Record<string, unknown> } | undefined>
}

export function publishedAgentPaths(config: ConfigLike, graphID: string): string[][] {
  return Object.entries(config.agent ?? {})
    .filter(([, agent]) => {
      if (!agent) return false
      const value = agent.options?.kiloOrchestration
      if (!value || typeof value !== "object" || Array.isArray(value)) return false
      const binding = value as Record<string, unknown>
      const graph = binding.graph
      if (!graph || typeof graph !== "object" || Array.isArray(graph)) return false
      const ref = graph as Record<string, unknown>
      return binding.version === 2 && ref.scope === "global" && ref.id === graphID
    })
    .map(([slug]) => ["agent", slug])
}

export async function unpublishGraph(client: KiloClient, directory: string, graphID: string): Promise<boolean> {
  const { data } = await client.config.overlay({ directory, scope: "global" }, { throwOnError: true })
  const unset = publishedAgentPaths(data.global, graphID)
  if (unset.length === 0) return false
  await client.config.overlayUpdate({ directory, scope: "global", unset }, { throwOnError: true })
  return true
}

export async function syncPublishedAgent(
  client: KiloClient,
  directory: string,
  graph: OrchestrationGraph,
): Promise<boolean> {
  const { data } = await client.config.overlay({ directory, scope: "global" }, { throwOnError: true })
  const paths = publishedAgentPaths(data.global, graph.id)
  if (paths.length === 0) return false
  const result = agentConfig(graph)
  const unset = paths.filter((path) => path[1] !== result.slug)
  await client.config.overlayUpdate(
    {
      directory,
      scope: "global",
      set: { agent: { [result.slug]: result.config } },
      ...(unset.length > 0 ? { unset } : {}),
    },
    { throwOnError: true },
  )
  return true
}

function agentConfig(graph: OrchestrationGraph): PublishResult {
  return {
    slug: slugify(graph.name),
    config: {
      mode: "primary",
      displayName: graph.name,
      description: `Deterministic orchestration "${graph.name}"`,
      prompt: null,
      options: {
        kiloOrchestration: { version: 2, graph: { id: graph.id, scope: "global" } },
      },
    },
  }
}

export function buildAgentConfigFromGraph(graph: OrchestrationGraph): PublishResult {
  if (graph.nodes.length === 0) throw new PublishError("Cannot publish an empty graph")
  if (!graph.entryNodeId) throw new PublishError("Set an entry node before publishing")
  if (!nodeById(graph, graph.entryNodeId)) throw new PublishError("The entry node no longer exists")
  return agentConfig(graph)
}
