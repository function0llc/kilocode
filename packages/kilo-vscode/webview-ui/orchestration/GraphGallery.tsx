import { createSignal, For, Show, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { createGraph } from "../../src/orchestration/domain"
import type { OrchestrationGraph } from "../../src/orchestration/domain"
import { useVSCode } from "../src/context/vscode"
import { useOrchestrationData } from "./data"
import { useOrchestrationLanguage } from "./language"

interface Props {
  onOpen: (graphId: string) => void
  onNew: (graph: OrchestrationGraph) => void
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export const GraphGallery: Component<Props> = (props) => {
  const vscode = useVSCode()
  const data = useOrchestrationData()
  const { t } = useOrchestrationLanguage()
  const [renaming, setRenaming] = createSignal<string | null>(null)
  const [confirming, setConfirming] = createSignal<string | null>(null)

  const create = () => {
    const names = new Set(data.graphs().map((g) => g.name))
    let n = 1
    let name = "Untitled orchestration"
    while (names.has(name)) {
      n++
      name = `Untitled orchestration ${n}`
    }
    props.onNew(createGraph(name))
  }

  const commitRename = (id: string, input: HTMLInputElement) => {
    if (renaming() !== id) return
    const name = input.value.trim()
    setRenaming(null)
    if (name) vscode.postMessage({ type: "orchestration.renameGraph", graphId: id, name })
  }

  return (
    <div class="orch-gallery">
      <div class="orch-gallery-header">
        <div class="orch-gallery-title">
          <h1>{t("orchestration.title")}</h1>
          <p>{t("orchestration.subtitle")}</p>
        </div>
        <Button variant="primary" icon="plus" onClick={create}>
          {t("orchestration.gallery.new")}
        </Button>
      </div>

      <div class="orch-gallery-body">
        <Show
          when={data.graphs().length > 0}
          fallback={<div class="orch-gallery-empty">{t("orchestration.gallery.empty")}</div>}
        >
          <div class="orch-gallery-grid">
            <For each={data.graphs()}>
              {(summary) => (
                <div class="orch-card" onClick={() => props.onOpen(summary.id)}>
                  <Show
                    when={renaming() !== summary.id}
                    fallback={
                      <div class="orch-card-rename" onClick={(e) => e.stopPropagation()}>
                        <input
                          value={summary.name}
                          ref={(el) => {
                            el.focus()
                            el.select()
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(summary.id, e.currentTarget)
                            if (e.key === "Escape") setRenaming(null)
                          }}
                          onBlur={(e) => commitRename(summary.id, e.currentTarget)}
                        />
                      </div>
                    }
                  >
                    <div class="orch-card-name" title={summary.name}>
                      {summary.name}
                    </div>
                  </Show>
                  <div class="orch-card-meta">
                    {t("orchestration.gallery.nodes", { count: summary.nodes })} · {relativeTime(summary.updatedAt)}
                  </div>
                  <div class="orch-card-actions" onClick={(e) => e.stopPropagation()}>
                    <IconButton
                      size="small"
                      variant="ghost"
                      icon="pencil-line"
                      title={t("orchestration.gallery.rename")}
                      onClick={() => setRenaming(summary.id)}
                    />
                    <IconButton
                      size="small"
                      variant="ghost"
                      icon="copy"
                      title={t("orchestration.gallery.duplicate")}
                      onClick={() => vscode.postMessage({ type: "orchestration.duplicateGraph", graphId: summary.id })}
                    />
                    <Show
                      when={confirming() !== summary.id}
                      fallback={
                        <Button size="small" variant="secondary" onClick={() => {
                          setConfirming(null)
                          vscode.postMessage({ type: "orchestration.deleteGraph", graphId: summary.id })
                        }}>
                          {t("orchestration.gallery.confirmDelete")}
                        </Button>
                      }
                    >
                      <IconButton
                        size="small"
                        variant="ghost"
                        icon="trash"
                        title={t("orchestration.gallery.delete")}
                        onClick={() => setConfirming(summary.id)}
                      />
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
