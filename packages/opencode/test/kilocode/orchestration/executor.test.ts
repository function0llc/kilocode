import { describe, expect, it } from "bun:test"
import type { AgentNode } from "../../../src/kilocode/orchestration/domain"
import { capabilityRules } from "../../../src/kilocode/orchestration/executor"
import type { EffectiveAgent } from "../../../src/kilocode/orchestration/resolver"

const effective: EffectiveAgent = {
  agentName: "source",
  displayName: "Source",
  prompt: { mode: "inherit" },
  permission: [
    { permission: "skill", pattern: "chart", action: "allow" },
    { permission: "github_*", pattern: "*", action: "ask" },
  ],
}

function node(): AgentNode {
  return {
    id: "node",
    kind: "agent",
    source: { agentName: "source" },
    position: { x: 0, y: 0 },
    overrides: {},
    capabilities: { skills: ["chart"], mcpServers: ["github"] },
    runtime: { retries: 0, failure: "stop", includeInFinalOutput: true },
  }
}

describe("orchestration capability rules", () => {
  it("allows selected skills only within source permissions", () => {
    const rules = capabilityRules(node(), effective, ["github"])
    expect(rules).toContainEqual({ permission: "skill", pattern: "*", action: "deny" })
    expect(rules.at(-1)).toEqual({ permission: "skill", pattern: "chart", action: "allow" })
  })

  it("denies tools and resources from unselected MCP servers", () => {
    const rules = capabilityRules(node(), effective, ["github", "internal.db"])
    expect(rules).toContainEqual({ permission: "internal_db_*", pattern: "*", action: "deny" })
    expect(rules).toContainEqual({ permission: "read", pattern: "mcp:internal.db:*", action: "deny" })
    expect(rules).not.toContainEqual({ permission: "github_*", pattern: "*", action: "deny" })
  })
})
