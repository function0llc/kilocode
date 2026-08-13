import { createSignal, onCleanup, Show, type Component } from "solid-js"
import { ThemeProvider } from "@kilocode/kilo-ui/theme"
import { DialogProvider } from "@kilocode/kilo-ui/context/dialog"
import { Toast } from "@kilocode/kilo-ui/toast"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { Button } from "@kilocode/kilo-ui/button"
import type { OrchestrationGraph } from "../../src/orchestration/domain"
import { VSCodeProvider, useVSCode } from "../src/context/vscode"
import { ProviderProvider } from "../src/context/provider"
import { LanguageProvider } from "../src/context/language"
import { OrchestrationDataProvider, useOrchestrationData } from "./data"
import { OrchestrationLanguageProvider, useOrchestrationLanguage } from "./language"
import { GraphGallery } from "./GraphGallery"
import { Editor } from "./Editor"

const AppBody: Component = () => {
  const vscode = useVSCode()
  const data = useOrchestrationData()
  const { t } = useOrchestrationLanguage()
  const [open, setOpen] = createSignal<OrchestrationGraph | null>(null)

  const unsub = vscode.onMessage((message) => {
    if (message.type === "orchestration.graph") setOpen(message.graph)
    if (message.type === "orchestration.deleted" && open()?.id === message.graphId) setOpen(null)
  })
  onCleanup(unsub)

  const connected = () => data.connection() === "connected"

  return (
    <div class="orch-root">
      <Show when={data.connection() === "connecting"}>
        <div class="orch-center">
          <Spinner />
          <span>{t("orchestration.connection.connecting")}</span>
        </div>
      </Show>
      <Show when={data.connection() === "error" || data.connection() === "disconnected"}>
        <div class="orch-center">
          <span>{t("orchestration.connection.error")}</span>
          <Button variant="secondary" onClick={data.retry}>
            {t("orchestration.connection.retry")}
          </Button>
        </div>
      </Show>
      <Show when={connected()}>
        <Show
          when={open()}
          keyed
          fallback={
            <GraphGallery
              onOpen={(graphId) => vscode.postMessage({ type: "orchestration.loadGraph", graphId })}
              onNew={setOpen}
            />
          }
        >
          {(graph) => (
            <Editor
              initial={graph}
              onClose={() => {
                setOpen(null)
                vscode.postMessage({ type: "orchestration.listGraphs" })
              }}
            />
          )}
        </Show>
      </Show>
    </div>
  )
}

const LanguageSetup: Component = () => {
  const data = useOrchestrationData()
  return (
    <LanguageProvider vscodeLanguage={() => data.locale()}>
      <OrchestrationLanguageProvider locale={data.locale}>
        <AppBody />
      </OrchestrationLanguageProvider>
    </LanguageProvider>
  )
}

export const OrchestrationApp: Component = () => {
  return (
    <ThemeProvider defaultTheme="kilo-vscode">
      <DialogProvider>
        <VSCodeProvider>
          <ProviderProvider>
            <OrchestrationDataProvider>
              <LanguageSetup />
            </OrchestrationDataProvider>
          </ProviderProvider>
        </VSCodeProvider>
        <Toast.Region />
      </DialogProvider>
    </ThemeProvider>
  )
}
