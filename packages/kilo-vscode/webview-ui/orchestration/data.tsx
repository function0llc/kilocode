// Orchestration data context. Reuses the existing palette message protocol
// (requestAgents/agentsLoaded, requestSkills/skillsLoaded,
// requestMcpStatus/mcpStatusLoaded) so no new request types were invented for
// palette data, plus the orchestration.* responses for graphs.

import {
  createContext,
  createSignal,
  onCleanup,
  onMount,
  useContext,
  type Accessor,
  type ParentComponent,
} from "solid-js"
import { useVSCode } from "../src/context/vscode"
import type { AgentInfo, ConnectionState, ExtensionMessage, McpStatusEntry, SkillInfo } from "../src/types/messages"
import type { GraphSummary } from "../src/types/messages/orchestration"

type OrchestrationDataContextValue = {
  connection: Accessor<ConnectionState>
  locale: Accessor<string | undefined>
  agents: Accessor<AgentInfo[]>
  skills: Accessor<SkillInfo[]>
  mcpStatus: Accessor<Record<string, McpStatusEntry>>
  graphs: Accessor<GraphSummary[]>
  retry: () => void
}

const OrchestrationDataContext = createContext<OrchestrationDataContextValue>()

export const OrchestrationDataProvider: ParentComponent = (props) => {
  const vscode = useVSCode()
  const [connection, setConnection] = createSignal<ConnectionState>("connecting")
  const [locale, setLocale] = createSignal<string | undefined>(undefined)
  const [agents, setAgents] = createSignal<AgentInfo[]>([])
  const [skills, setSkills] = createSignal<SkillInfo[]>([])
  const [mcpStatus, setMcpStatus] = createSignal<Record<string, McpStatusEntry>>({})
  const [graphs, setGraphs] = createSignal<GraphSummary[]>([])

  const request = () => {
    vscode.postMessage({ type: "requestAgents" })
    vscode.postMessage({ type: "requestSkills" })
    vscode.postMessage({ type: "requestMcpStatus" })
    vscode.postMessage({ type: "orchestration.listGraphs" })
  }

  // Subscribe outside onMount so early pushes before mount are not missed.
  const unsub = vscode.onMessage((message: ExtensionMessage) => {
    switch (message.type) {
      case "orchestration.ready":
        setLocale(message.languageOverride || message.vscodeLanguage)
        return
      case "connectionState":
        setConnection(message.state)
        if (message.state === "connected") request()
        return
      case "agentsLoaded":
        setAgents(message.allAgents)
        return
      case "skillsLoaded":
        setSkills(message.skills)
        return
      case "mcpStatusLoaded":
        setMcpStatus(message.status)
        return
      case "orchestration.graphs":
        setGraphs(message.graphs)
        return
    }
  })
  onCleanup(unsub)

  onMount(() => {
    vscode.postMessage({ type: "webviewReady" })
  })

  return (
    <OrchestrationDataContext.Provider
      value={{
        connection,
        locale,
        agents,
        skills,
        mcpStatus,
        graphs,
        retry: () => vscode.postMessage({ type: "retryConnection" }),
      }}
    >
      {props.children}
    </OrchestrationDataContext.Provider>
  )
}

export function useOrchestrationData(): OrchestrationDataContextValue {
  const ctx = useContext(OrchestrationDataContext)
  if (!ctx) throw new Error("useOrchestrationData must be used within OrchestrationDataProvider")
  return ctx
}
