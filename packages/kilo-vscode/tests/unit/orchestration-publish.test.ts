import { describe, expect, it } from "bun:test"
import { createAgentNode, createCheckpointNode, createGraph } from "../../src/orchestration/domain"
import type { OrchestrationGraph } from "../../src/orchestration/domain"
import {
  buildAgentConfigFromGraph,
  publishedAgentPaths,
  PublishError,
  unpublishGraph,
} from "../../src/orchestration/publish"

function graph(patch: Partial<OrchestrationGraph>): OrchestrationGraph {
  return { ...createGraph("Demo Pipeline"), ...patch }
}

describe("orchestration publish", () => {
  it("publishes a runtime binding and clears a prior coordinator prompt", () => {
    const result = buildAgentConfigFromGraph(
      graph({ id: "demo", entryNodeId: "a", nodes: [createAgentNode("a", "architect", { x: 0, y: 0 })] }),
    )
    expect(result.slug).toBe("demo-pipeline")
    expect(result.config).toEqual({
      mode: "primary",
      displayName: "Demo Pipeline",
      description: 'Deterministic orchestration "Demo Pipeline"',
      prompt: null,
      options: { kiloOrchestration: { version: 2, graph: { id: "demo", scope: "global" } } },
    })
    expect(JSON.stringify(result.config)).not.toContain("task")
    expect(JSON.stringify(result.config)).not.toContain("subagent_depth")
  })

  it("supports checkpoint graphs", () => {
    expect(() =>
      buildAgentConfigFromGraph(
        graph({ entryNodeId: "cp", nodes: [createCheckpointNode("cp", { x: 0, y: 0 })] }),
      ),
    ).not.toThrow()
  })

  it("rejects graphs that cannot start", () => {
    expect(() => buildAgentConfigFromGraph(graph({}))).toThrow(PublishError)
    expect(() =>
      buildAgentConfigFromGraph(
        graph({ entryNodeId: "ghost", nodes: [createAgentNode("a", "architect", { x: 0, y: 0 })] }),
      ),
    ).toThrow(PublishError)
  })

  it("finds only agents published from the deleted graph", () => {
    const binding = (id: string) => ({
      options: { kiloOrchestration: { version: 2, graph: { id, scope: "global" } } },
    })
    expect(
      publishedAgentPaths(
        {
          agent: {
            "test-plan": binding("test-plan"),
            architect: {},
            "other-plan": binding("other-plan"),
          },
        },
        "test-plan",
      ),
    ).toEqual([["agent", "test-plan"]])
  })

  it("unpublishes every agent bound to the graph without touching source agents", async () => {
    const patches: unknown[] = []
    const client = {
      config: {
        overlay: async () => ({
          data: {
            global: {
              agent: {
                current: {
                  options: { kiloOrchestration: { version: 2, graph: { id: "test-plan", scope: "global" } } },
                },
                renamed: {
                  options: { kiloOrchestration: { version: 2, graph: { id: "test-plan", scope: "global" } } },
                },
                architect: {},
              },
            },
          },
        }),
        overlayUpdate: async (patch: unknown) => {
          patches.push(patch)
          return { data: {} }
        },
      },
    }

    expect(await unpublishGraph(client as never, "/repo", "test-plan")).toBe(true)
    expect(patches).toEqual([
      {
        directory: "/repo",
        scope: "global",
        unset: [
          ["agent", "current"],
          ["agent", "renamed"],
        ],
      },
    ])
  })
})
