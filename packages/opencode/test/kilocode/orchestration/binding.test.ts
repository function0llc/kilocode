import { describe, expect, it } from "bun:test"
import { stripInternalOptions } from "../../../src/kilocode/agent/options"
import { binding } from "../../../src/kilocode/orchestration/binding"

describe("orchestration binding", () => {
  it("accepts only the supported graph reference", () => {
    expect(binding({ version: 2, graph: { id: "release", scope: "global" } })).toEqual({
      version: 2,
      graph: { id: "release", scope: "global" },
    })
    expect(binding({ version: 1, graph: { id: "release", scope: "global" } })).toBeUndefined()
    expect(binding({ version: 2, graph: { id: "", scope: "global" } })).toBeUndefined()
    expect(binding({ version: 2, graph: { id: "release", scope: "project" } })).toBeUndefined()
  })

  it("never forwards the binding to providers", () => {
    expect(stripInternalOptions({ kiloOrchestration: { version: 2 }, reasoning: "high" })).toEqual({
      reasoning: "high",
    })
  })
})
