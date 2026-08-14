import { createMemo, createSignal, onCleanup, Show, type Component } from "solid-js"
import { createStore, produce, reconcile, unwrap } from "solid-js/store"
import { showToast } from "@kilocode/kilo-ui/toast"
import { Button } from "@kilocode/kilo-ui/button"
import { TextField } from "@kilocode/kilo-ui/text-field"
import {
  createAgentNode,
  createCheckpointNode,
  createId,
  isAgentNode,
  validateGraph,
} from "../../src/orchestration/domain"
import type { OrchestrationGraph } from "../../src/orchestration/domain"
import { useVSCode } from "../src/context/vscode"
import { useOrchestrationData } from "./data"
import { useOrchestrationLanguage } from "./language"
import { Canvas } from "./Canvas"
import { Palette } from "./Palette"
import { Inspector } from "./Inspector"
import { Toolbar } from "./Toolbar"
import type { CanvasApi, Selection } from "./types"
import type { OrchestrationRun } from "../src/types/messages/orchestration"

interface Props {
  initial: OrchestrationGraph
  existing: boolean
  onClose: () => void
}

export const Editor: Component<Props> = (props) => {
  const vscode = useVSCode()
  const data = useOrchestrationData()
  const { t } = useOrchestrationLanguage()

  const [graph, setGraph] = createStore<OrchestrationGraph>(props.initial)
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [existing, setExisting] = createSignal(props.existing)
  const [publishing, setPublishing] = createSignal(false)
  const [pendingPublish, setPendingPublish] = createSignal(false)
  const [selected, setSelected] = createSignal<Selection | null>(null)
  const saved = vscode.getState<{ runId?: string; input?: string; inspectorWidth?: number }>()
  const [input, setInput] = createSignal(saved?.input ?? "")
  const [run, setRun] = createSignal<OrchestrationRun | null>(null)
  const [feedback, setFeedback] = createSignal("")
  const [pendingRun, setPendingRun] = createSignal(false)
  const [inspectorWidth, setInspectorWidth] = createSignal(saved?.inspectorWidth ?? 300)

  const api: CanvasApi = {
    zoomIn: () => {},
    zoomOut: () => {},
    fit: () => {},
    centerWorld: () => ({ x: 0, y: 0 }),
  }

  const knownAgents = createMemo(() => new Set(data.agents().map((agent) => agent.name)))
  // An empty roster means agents have not loaded yet — skip the unknown-agent check.
  const issues = createMemo(() => validateGraph(graph, knownAgents().size > 0 ? knownAgents() : undefined))
  const issueMessages = createMemo(() =>
    issues()
      .map((issue) => issue.message)
      .join("; "),
  )
  const canPublish = createMemo(
    () => !!graph.name.trim() && graph.nodes.length > 0 && !!graph.entryNodeId && issues().length === 0,
  )
  const canSetEntry = createMemo(() => selected()?.kind === "node")
  const running = createMemo(() => run()?.status === "running" || run()?.status === "waiting-for-user")

  const persist = (id = run()?.id) => vscode.setState({ runId: id, input: input(), inspectorWidth: inspectorWidth() })

  const resizeInspector = (event: PointerEvent) => {
    event.preventDefault()
    const start = { x: event.clientX, width: inspectorWidth() }
    const move = (next: PointerEvent) => {
      const max = Math.max(320, Math.min(640, window.innerWidth - 420))
      setInspectorWidth(Math.min(max, Math.max(220, start.width + start.x - next.clientX)))
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      persist()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const resizeInspectorKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const change = event.key === "ArrowLeft" ? 20 : -20
    const max = Math.max(320, Math.min(640, window.innerWidth - 420))
    setInspectorWidth((width) => Math.min(max, Math.max(220, width + change)))
    persist()
  }

  const start = () => {
    if (running() || !canPublish()) return
    if (dirty()) {
      setPendingRun(true)
      save()
      return
    }
    vscode.postMessage({ type: "orchestration.startRun", graph: unwrap(graph), input: input() })
  }

  const mutate = (fn: (g: OrchestrationGraph) => void) => {
    setGraph(produce(fn))
    setDirty(true)
  }

  const save = () => {
    if (saving() || !graph.name.trim()) return
    if (graph.name !== graph.name.trim()) {
      setGraph("name", graph.name.trim())
    }
    setSaving(true)
    vscode.postMessage({ type: "orchestration.saveGraph", graph: unwrap(graph), existing: existing() })
  }

  const publish = () => {
    if (publishing() || !canPublish()) return
    // Publish reads the stored graph from disk, so flush unsaved edits first.
    if (dirty()) {
      setPendingPublish(true)
      save()
      return
    }
    setPublishing(true)
    vscode.postMessage({ type: "orchestration.publishAsAgent", graphId: graph.id })
  }

  const setEntry = (nodeId: string) => {
    mutate((g) => {
      g.entryNodeId = nodeId
    })
  }

  const removeNode = (nodeId: string) => {
    mutate((g) => {
      g.nodes = g.nodes.filter((node) => node.id !== nodeId)
      g.edges = g.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId)
      if (g.entryNodeId === nodeId) g.entryNodeId = null
    })
    setSelected(null)
  }

  const removeEdge = (edgeId: string) => {
    mutate((g) => {
      g.edges = g.edges.filter((edge) => edge.id !== edgeId)
    })
    setSelected(null)
  }

  const removeSelection = () => {
    const sel = selected()
    if (!sel) return
    if (sel.kind === "node") removeNode(sel.id)
    if (sel.kind === "edge") removeEdge(sel.id)
  }

  const removeCapability = (nodeId: string, kind: "skill" | "mcp", name: string) => {
    mutate((g) => {
      const node = g.nodes.find((item) => item.id === nodeId)
      if (!node || !isAgentNode(node)) return
      if (kind === "skill") node.capabilities.skills = node.capabilities.skills.filter((s) => s !== name)
      if (kind === "mcp") node.capabilities.mcpServers = node.capabilities.mcpServers.filter((s) => s !== name)
    })
  }

  const addAgent = (agentName: string, kind: "agent" | "subagent") => {
    const center = api.centerWorld()
    const offset = (graph.nodes.length % 5) * 36
    const id = createId("node")
    mutate((g) => {
      g.nodes.push(createAgentNode(id, agentName, { x: center.x - 92 + offset, y: center.y - 36 + offset }))
    })
    setSelected({ kind: "node", id })
  }

  const addCheckpoint = () => {
    const center = api.centerWorld()
    const offset = (graph.nodes.length % 5) * 36
    const id = createId("node")
    mutate((g) => {
      g.nodes.push(createCheckpointNode(id, { x: center.x - 92 + offset, y: center.y - 36 + offset }))
    })
    setSelected({ kind: "node", id })
  }

  const attach = (kind: "skill" | "mcp", name: string) => {
    const sel = selected()
    if (sel?.kind !== "node") {
      showToast({ description: t("orchestration.palette.hint") })
      return
    }
    const nodeId = sel.id
    mutate((g) => {
      const node = g.nodes.find((item) => item.id === nodeId)
      if (!node || !isAgentNode(node)) return
      if (kind === "skill" && !node.capabilities.skills.includes(name)) node.capabilities.skills.push(name)
      if (kind === "mcp" && !node.capabilities.mcpServers.includes(name)) node.capabilities.mcpServers.push(name)
    })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault()
      removeSelection()
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault()
      save()
    }
  }
  window.addEventListener("keydown", onKeyDown)
  onCleanup(() => window.removeEventListener("keydown", onKeyDown))

  const unsub = vscode.onMessage((message) => {
    switch (message.type) {
      case "orchestration.saved":
        setGraph(reconcile(message.graph))
        setExisting(true)
        setDirty(false)
        setSaving(false)
        if (pendingPublish()) {
          setPendingPublish(false)
          setPublishing(true)
          vscode.postMessage({ type: "orchestration.publishAsAgent", graphId: message.graph.id })
          return
        }
        if (pendingRun()) {
          setPendingRun(false)
          vscode.postMessage({ type: "orchestration.startRun", graph: message.graph, input: input() })
          return
        }
        showToast({ description: t("orchestration.saved") })
        return
      case "orchestration.published":
        setPublishing(false)
        showToast({ icon: "check", description: t("orchestration.published", { name: message.agentName }) })
        return
      case "orchestration.failed":
        setSaving(false)
        setPublishing(false)
        setPendingPublish(false)
        setPendingRun(false)
        showToast({ variant: "error", title: t("orchestration.failed"), description: message.message })
        return
      case "orchestration.run":
        setRun(message.run)
        persist(message.run.id)
        return
      case "orchestration.runEvent": {
        const current = run()
        if (current && current.id === message.runId && Number(current.revision) >= message.revision) return
        vscode.postMessage({ type: "orchestration.getRun", runId: message.runId })
        return
      }
    }
  })
  onCleanup(unsub)
  if (saved?.runId) vscode.postMessage({ type: "orchestration.getRun", runId: saved.runId })

  return (
    <div class="orch-editor">
      <Toolbar
        name={() => graph.name}
        dirty={dirty}
        saving={saving}
        publishing={publishing}
        running={running}
        status={() => run()?.status}
        input={input}
        canSetEntry={canSetEntry}
        canPublish={canPublish}
        publishHint={() => issueMessages()}
        onName={(name) => {
          if (name === graph.name) return
          setGraph("name", name)
          setDirty(true)
        }}
        onSave={save}
        onSetEntry={() => {
          const sel = selected()
          if (sel?.kind === "node") setEntry(sel.id)
        }}
        onPublish={publish}
        onInput={(value) => {
          setInput(value)
          persist()
        }}
        onRun={start}
        onStop={() => {
          const id = run()?.id
          if (id) vscode.postMessage({ type: "orchestration.cancelRun", runId: id })
        }}
        onBack={() => {
          vscode.postMessage({ type: "orchestration.listGraphs" })
          props.onClose()
        }}
        api={api}
      />
      <div class="orch-editor-body">
        <Palette onAddAgent={addAgent} onAddCheckpoint={addCheckpoint} onAttach={attach} />
        <Canvas
          graph={graph}
          run={run}
          selected={selected}
          onSelect={setSelected}
          mutate={mutate}
          knownAgents={knownAgents}
          api={api}
        />
        <div class="orch-inspector-shell" style={{ width: `${inspectorWidth()}px` }}>
          <div
            class="orch-inspector-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("orchestration.inspector.resize")}
            aria-valuenow={inspectorWidth()}
            tabindex="0"
            onPointerDown={resizeInspector}
            onKeyDown={resizeInspectorKey}
          />
          <Inspector
            graph={graph}
            selected={selected}
            onSetEntry={setEntry}
            onSetOutput={(nodeId) => {
              mutate((g) => {
                g.outputNodeId = g.outputNodeId === nodeId ? null : nodeId
              })
            }}
            onRemoveNode={removeNode}
            onRemoveEdge={removeEdge}
            onRemoveCapability={removeCapability}
            mutate={mutate}
          />
        </div>
      </div>
      <Show when={run()?.waiting}>
        {(waiting) => (
          <div class="orch-checkpoint-bar">
            <strong>{waiting().prompt}</strong>
            <TextField value={feedback()} placeholder={t("orchestration.run.feedback")} onChange={setFeedback} />
            <div class="orch-checkpoint-options">
              {waiting().options.map((option) => (
                <Button
                  size="small"
                  variant="primary"
                  onClick={() => {
                    const current = run()
                    if (!current) return
                    vscode.postMessage({
                      type: "orchestration.resolveCheckpoint",
                      runId: current.id,
                      nodeId: waiting().nodeId,
                      outcome: option.id,
                      feedback: feedback() || undefined,
                    })
                    setFeedback("")
                  }}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        )}
      </Show>
      <Show when={run()?.output}>
        {(output) => (
          <div class="orch-run-output">
            <strong>{t("orchestration.run.output")}</strong>
            <pre>{output()}</pre>
          </div>
        )}
      </Show>
    </div>
  )
}
