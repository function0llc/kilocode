import { describe, expect, it } from "bun:test"
import type { AgentNode } from "../../../src/kilocode/orchestration/domain"
import { buildSystemPrompt, buildUserPrompt } from "../../../src/kilocode/orchestration/prompt"
import { resolveNodeAgent } from "../../../src/kilocode/orchestration/resolver"

function node(overrides: AgentNode["overrides"] = {}): AgentNode {
  return {
    id: "review",
    kind: "agent",
    source: { agentName: "source" },
    position: { x: 0, y: 0 },
    overrides,
    capabilities: { skills: [], mcpServers: [] },
    runtime: { retries: 0, failure: "stop", includeInFinalOutput: true },
  }
}

const source = {
  kind: "agent" as const,
  agent: {
    name: "source",
    displayName: "Source agent",
    description: "Inherited description",
    model: { providerID: "source-provider", modelID: "source-model" },
    variant: "high",
    prompt: "Source prompt",
    temperature: 0.4,
    topP: 0.8,
    steps: 12,
    permission: [{ permission: "read", pattern: "*", action: "allow" as const }],
  },
}

describe("orchestration effective agent", () => {
  it("inherits source fields without mutating the source", () => {
    const before = structuredClone(source.agent)
    const result = resolveNodeAgent(node(), source, { providerID: "default", modelID: "default" })

    expect(result).toMatchObject({
      agentName: "source",
      displayName: "Source agent",
      description: "Inherited description",
      model: { providerID: "source-provider", modelID: "source-model" },
      variant: "high",
      prompt: { mode: "inherit", source: "Source prompt" },
      temperature: 0.4,
      topP: 0.8,
      steps: 12,
    })
    expect(source.agent).toEqual(before)
  })

  it("applies overrides and explicit clears", () => {
    const result = resolveNodeAgent(
      node({
        displayName: "Local reviewer",
        description: null,
        model: { providerID: "local-provider", modelID: "local-model" },
        variant: null,
        temperature: 0,
        topP: null,
        steps: 3,
        prompt: { mode: "replace", text: "Only review correctness." },
      }),
      source,
    )

    expect(result.displayName).toBe("Local reviewer")
    expect(result.description).toBeUndefined()
    expect(result.model).toEqual({ providerID: "local-provider", modelID: "local-model" })
    expect(result.variant).toBeUndefined()
    expect(result.temperature).toBe(0)
    expect(result.topP).toBeUndefined()
    expect(result.steps).toBe(3)
    expect(result.prompt).toEqual({ mode: "replace", text: "Only review correctness." })
  })

  it("uses the configured default model only when source and node omit it", () => {
    const result = resolveNodeAgent(node(), { kind: "agent", agent: { name: "source" } }, {
      providerID: "default",
      modelID: "model",
    })
    expect(result.model).toEqual({ providerID: "default", modelID: "model" })
  })
})

describe("orchestration prompts", () => {
  it("builds append and replace prompts without scheduling instructions", () => {
    const append = resolveNodeAgent(node({ prompt: { mode: "append", text: "Check tests." } }), source)
    const replace = resolveNodeAgent(node({ prompt: { mode: "replace", text: "Only check security." } }), source)

    expect(buildSystemPrompt(append, node(), 2)).toContain("Source prompt")
    expect(buildSystemPrompt(append, node(), 2)).toContain("Check tests.")
    expect(buildSystemPrompt(replace, node(), 0)).not.toContain("Source prompt")
    expect(buildSystemPrompt(replace, node(), 0)).toContain("Only check security.")
  })

  it("labels predecessor successes and failures and carries reprocessing context", () => {
    const prompt = buildUserPrompt({
      workflowInput: "Ship the release",
      node: node(),
      iteration: 1,
      attempt: 2,
      predecessors: [
        { nodeId: "a", label: "Planner", round: 1, output: "Plan" },
        { nodeId: "b", label: "Tests", round: 1, failed: true, error: "Failed" },
      ],
      previousOutput: "Old review",
      feedback: "Address the failure",
      reprocessReason: "request_changes",
    })

    expect(prompt).toContain("## Planner (round 1)\n\nPlan")
    expect(prompt).toContain("## Tests (failed, round 1)\n\nError: Failed")
    expect(prompt).toContain("Old review")
    expect(prompt).toContain("Address the failure")
  })
})
