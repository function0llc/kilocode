import { createSignal, onCleanup, onMount, type Component } from "solid-js"
import type { OrchestrationGraph } from "../../../../src/orchestration/domain"
import { useVSCode } from "../../context/vscode"
import { GraphGallery } from "../../../orchestration/GraphGallery"
import { Editor } from "../../../orchestration/Editor"
import { OrchestrationDataProvider, useOrchestrationData } from "../../../orchestration/data"
import { OrchestrationLanguageProvider } from "../../../orchestration/language"
import "../../../orchestration/orchestration.css"

const Content: Component = () => {
  const vscode = useVSCode()
  const data = useOrchestrationData()
  const [open, setOpen] = createSignal<OrchestrationGraph | null>(null)

  const unsub = vscode.onMessage((message) => {
    if (message.type === "orchestration.graph") setOpen(message.graph)
    if (message.type === "orchestration.deleted" && open()?.id === message.graphId) setOpen(null)
  })
  onCleanup(unsub)
  onMount(() => vscode.postMessage({ type: "orchestration.listGraphs" }))

  return (
    <div class="orch-settings">
      {open() ? (
        <Editor
          initial={open()!}
          onClose={() => {
            setOpen(null)
            vscode.postMessage({ type: "orchestration.listGraphs" })
          }}
        />
      ) : (
        <GraphGallery
          onOpen={(graphId) => vscode.postMessage({ type: "orchestration.loadGraph", graphId })}
          onNew={setOpen}
        />
      )}
    </div>
  )
}

const Language: Component = () => {
  const data = useOrchestrationData()
  return (
    <OrchestrationLanguageProvider locale={data.locale}>
      <Content />
    </OrchestrationLanguageProvider>
  )
}

const OrchestrationTab: Component = () => (
  <OrchestrationDataProvider>
    <Language />
  </OrchestrationDataProvider>
)

export default OrchestrationTab
