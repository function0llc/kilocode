import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js"
import { showToast } from "@kilocode/kilo-ui/toast"
import { Icon } from "@kilocode/kilo-ui/icon"
import {
  connectError,
  createAgentNode,
  createEdge,
  createId,
  isAgentNode,
  nodeById,
  nodeLabel,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "../../src/orchestration/domain"
import type { OrchestrationGraph, OrchestrationNode } from "../../src/orchestration/domain"
import {
  getDrag,
  PALETTE_DROP,
  PALETTE_END,
  PALETTE_MOVE,
  setDrag,
  type CanvasApi,
  type PaletteDragItem,
  type PalettePointerDetail,
  type Selection,
} from "./types"
import { useOrchestrationLanguage } from "./language"
import type { OrchestrationRun } from "../src/types/messages/orchestration"

interface Props {
  graph: OrchestrationGraph
  run: () => OrchestrationRun | null
  selected: () => Selection | null
  onSelect: (selection: Selection | null) => void
  mutate: (fn: (graph: OrchestrationGraph) => void) => void
  knownAgents: () => Set<string>
  api: CanvasApi
}

/** Cubic bezier from a node's bottom anchor to another node's top anchor. */
export function edgePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const sx = from.x + NODE_WIDTH / 2
  const sy = from.y + NODE_HEIGHT
  const tx = to.x + NODE_WIDTH / 2
  const ty = to.y
  const d = Math.max(36, Math.min(140, Math.abs(ty - sy) / 2 + 30))
  return `M ${sx} ${sy} C ${sx} ${sy + d}, ${tx} ${ty - d}, ${tx} ${ty}`
}

function edgePoints(from: { x: number; y: number }, to: { x: number; y: number }) {
  const sx = from.x + NODE_WIDTH / 2
  const sy = from.y + NODE_HEIGHT
  const tx = to.x + NODE_WIDTH / 2
  const ty = to.y
  const d = Math.max(36, Math.min(140, Math.abs(ty - sy) / 2 + 30))
  return [{ x: sx, y: sy + d }, { x: tx, y: ty - d }] as const
}

function controlledPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  controls?: [{ x: number; y: number }, { x: number; y: number }],
) {
  const sx = from.x + NODE_WIDTH / 2
  const sy = from.y + NODE_HEIGHT
  const tx = to.x + NODE_WIDTH / 2
  const ty = to.y
  const points = controls ?? edgePoints(from, to)
  return `M ${sx} ${sy} C ${points[0].x} ${points[0].y}, ${points[1].x} ${points[1].y}, ${tx} ${ty}`
}

function dragPayload(event: DragEvent): PaletteDragItem | null {
  const raw = event.dataTransfer?.getData("text/plain")
  if (!raw) return getDrag()
  try {
    const item = JSON.parse(raw) as PaletteDragItem
    if (item && typeof item.name === "string" && typeof item.kind === "string") return item
    return null
  } catch {
    return null
  }
}

function nodeAt(clientX: number, clientY: number): string | null {
  const el = document.elementFromPoint(clientX, clientY)
  return el?.closest?.("[data-node-id]")?.getAttribute("data-node-id") ?? null
}

export const Canvas: Component<Props> = (props) => {
  const { t } = useOrchestrationLanguage()
  let container: HTMLDivElement | undefined
  const [view, setView] = createSignal({ x: 80, y: 80, k: 1 })
  const [connecting, setConnecting] = createSignal<{ from: string; x: number; y: number } | null>(null)
  const [over, setOver] = createSignal(false)
  let size: { width: number; height: number } | undefined
  let observer: ResizeObserver | undefined

  const contains = (x: number, y: number) => {
    const rect = container?.getBoundingClientRect()
    return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  }

  const toWorld = (clientX: number, clientY: number) => {
    const rect = container!.getBoundingClientRect()
    const v = view()
    return { x: (clientX - rect.left - v.x) / v.k, y: (clientY - rect.top - v.y) / v.k }
  }

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const rect = container?.getBoundingClientRect()
    if (!rect) return
    const px = clientX - rect.left
    const py = clientY - rect.top
    setView((v) => {
      const k = Math.min(2, Math.max(0.25, v.k * factor))
      const scale = k / v.k
      return { k, x: px - (px - v.x) * scale, y: py - (py - v.y) * scale }
    })
  }

  const zoomCenter = (factor: number) => {
    const rect = container?.getBoundingClientRect()
    if (!rect) return
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
  }

  const fit = () => {
    const rect = container?.getBoundingClientRect()
    const nodes = props.graph.nodes
    if (!rect || nodes.length === 0) return
    const minX = Math.min(...nodes.map((node) => node.position.x))
    const minY = Math.min(...nodes.map((node) => node.position.y))
    const maxX = Math.max(...nodes.map((node) => node.position.x + NODE_WIDTH))
    const maxY = Math.max(...nodes.map((node) => node.position.y + NODE_HEIGHT))
    const k = Math.min(
      1.5,
      Math.max(0.25, Math.min((rect.width - 100) / (maxX - minX), (rect.height - 100) / (maxY - minY))),
    )
    setView({
      k,
      x: (rect.width - (maxX - minX) * k) / 2 - minX * k,
      y: (rect.height - (maxY - minY) * k) / 2 - minY * k,
    })
  }

  props.api.zoomIn = () => zoomCenter(1.2)
  props.api.zoomOut = () => zoomCenter(1 / 1.2)
  props.api.fit = fit
  props.api.centerWorld = () => {
    const rect = container?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015))
  }

  /** Background pan. Only starts when the click lands on the canvas itself. */
  const onPan = (e: PointerEvent) => {
    if (e.target !== e.currentTarget) return
    props.onSelect(null)
    const start = { x: e.clientX, y: e.clientY, vx: view().x, vy: view().y }
    const move = (ev: PointerEvent) =>
      setView((v) => ({ ...v, x: start.vx + ev.clientX - start.x, y: start.vy + ev.clientY - start.y }))
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const dragNode = (e: PointerEvent, id: string) => {
    e.stopPropagation()
    const node = nodeById(props.graph, id)
    if (!node) return
    const start = { x: e.clientX, y: e.clientY, nx: node.position.x, ny: node.position.y }
    let moved = false
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 3) moved = true
      if (!moved) return
      const dx = (ev.clientX - start.x) / view().k
      const dy = (ev.clientY - start.y) / view().k
      props.mutate((g) => {
        const target = g.nodes.find((item) => item.id === id)
        if (target) target.position = { x: start.nx + dx, y: start.ny + dy }
      })
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      if (!moved) props.onSelect({ kind: "node", id })
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const startConnect = (e: PointerEvent, from: string) => {
    e.stopPropagation()
    const pos = toWorld(e.clientX, e.clientY)
    setConnecting({ from, x: pos.x, y: pos.y })
    const move = (ev: PointerEvent) => {
      const p = toWorld(ev.clientX, ev.clientY)
      setConnecting((c) => (c ? { ...c, x: p.x, y: p.y } : c))
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      const current = connecting()
      setConnecting(null)
      if (!current) return
      const to = nodeAt(ev.clientX, ev.clientY)
      if (!to) return
      const error = connectError(props.graph, current.from, to)
      if (error) {
        showToast({ variant: "error", description: error })
        return
      }
      const id = createId("edge")
      props.mutate((g) => {
        g.edges.push(createEdge(id, current.from, to))
      })
      props.onSelect({ kind: "edge", id })
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const dragControl = (event: PointerEvent, edgeId: string, index: 0 | 1) => {
    event.stopPropagation()
    const edge = props.graph.edges.find((item) => item.id === edgeId)
    if (!edge) return
    const source = nodeById(props.graph, edge.from)
    const target = nodeById(props.graph, edge.to)
    if (!source || !target) return
    if (!edge.meta?.controls) {
      const points = edgePoints(source.position, target.position)
      props.mutate((graph) => {
        const current = graph.edges.find((item) => item.id === edgeId)
        if (current) current.meta = { controls: [{ ...points[0] }, { ...points[1] }] }
      })
    }
    const move = (next: PointerEvent) => {
      const point = toWorld(next.clientX, next.clientY)
      props.mutate((graph) => {
        const current = graph.edges.find((item) => item.id === edgeId)
        if (!current) return
        const from = nodeById(graph, current.from)
        const to = nodeById(graph, current.to)
        if (!from || !to) return
        const points = current.meta?.controls ?? edgePoints(from.position, to.position).map((item) => ({ ...item }))
        points[index] = point
        current.meta = { controls: points as [{ x: number; y: number }, { x: number; y: number }] }
      })
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const onDragOver = (e: DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"
    setOver(true)
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const item = dragPayload(e)
    setDrag(null)
    if (!item) return
    if (item.kind === "agent" || item.kind === "subagent") {
      const pos = toWorld(e.clientX, e.clientY)
      const id = createId("node")
      props.mutate((g) => {
        g.nodes.push(createAgentNode(id, item.name, { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 }))
      })
      props.onSelect({ kind: "node", id })
      return
    }
    // Capability items attach to the node under the cursor.
    const nodeId = nodeAt(e.clientX, e.clientY)
    if (!nodeId) return
    const kind = item.kind
    props.mutate((g) => {
      const node = g.nodes.find((n) => n.id === nodeId)
      if (!node || !isAgentNode(node)) return
      if (kind === "skill" && !node.capabilities.skills.includes(item.name)) node.capabilities.skills.push(item.name)
      if (kind === "mcp" && !node.capabilities.mcpServers.includes(item.name))
        node.capabilities.mcpServers.push(item.name)
    })
  }

  const pointerMove = (event: Event) => {
    const detail = (event as CustomEvent<PalettePointerDetail>).detail
    setOver(contains(detail.clientX, detail.clientY))
  }

  const pointerDrop = (event: Event) => {
    const detail = (event as CustomEvent<PalettePointerDetail>).detail
    setOver(false)
    if (!contains(detail.clientX, detail.clientY)) return
    if (detail.item.kind === "agent" || detail.item.kind === "subagent") {
      const pos = toWorld(detail.clientX, detail.clientY)
      const id = createId("node")
      props.mutate((graph) => {
        graph.nodes.push(
          createAgentNode(id, detail.item.name, { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 }),
        )
      })
      props.onSelect({ kind: "node", id })
      return
    }
    const id = nodeAt(detail.clientX, detail.clientY)
    if (!id) return
    props.mutate((graph) => {
      const node = graph.nodes.find((item) => item.id === id)
      if (!node || !isAgentNode(node)) return
      if (detail.item.kind === "skill" && !node.capabilities.skills.includes(detail.item.name)) {
        node.capabilities.skills.push(detail.item.name)
      }
      if (detail.item.kind === "mcp" && !node.capabilities.mcpServers.includes(detail.item.name)) {
        node.capabilities.mcpServers.push(detail.item.name)
      }
    })
  }

  const pointerEnd = () => setOver(false)

  onMount(() => {
    window.addEventListener(PALETTE_MOVE, pointerMove)
    window.addEventListener(PALETTE_DROP, pointerDrop)
    window.addEventListener(PALETTE_END, pointerEnd)
    observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const next = entry.contentRect
      if (size) {
        const dx = (next.width - size.width) / 2
        const dy = (next.height - size.height) / 2
        setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }))
      }
      size = { width: next.width, height: next.height }
    })
    if (container) observer.observe(container)
  })
  onCleanup(() => {
    window.removeEventListener(PALETTE_MOVE, pointerMove)
    window.removeEventListener(PALETTE_DROP, pointerDrop)
    window.removeEventListener(PALETTE_END, pointerEnd)
    observer?.disconnect()
  })

  const unresolved = (node: OrchestrationNode) => {
    const roster = props.knownAgents()
    return isAgentNode(node) && roster.size > 0 && !roster.has(node.source.agentName)
  }

  const nodeRun = (id: string) => props.run()?.nodes[id]?.at(-1)

  const ghostFrom = () => {
    const current = connecting()
    if (!current) return null
    const source = nodeById(props.graph, current.from)
    if (!source) return null
    return edgePath(source.position, { x: current.x - NODE_WIDTH / 2, y: current.y })
  }

  return (
    <div
      ref={container}
      class="orch-canvas"
      classList={{ "drag-over": over() }}
      onWheel={onWheel}
      onPointerDown={onPan}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={onDrop}
    >
      <Show when={props.graph.nodes.length === 0}>
        <div class="orch-canvas-placeholder">{t("orchestration.canvas.placeholder")}</div>
      </Show>

      <div class="orch-viewport" style={{ transform: `translate(${view().x}px, ${view().y}px) scale(${view().k})` }}>
        <svg class="orch-edges" width="1" height="1">
          <defs>
            <marker
              id="orch-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" class="orch-arrow-head" />
            </marker>
          </defs>
          <For each={props.graph.edges}>
            {(edge) => {
              const source = () => nodeById(props.graph, edge.from)
              const target = () => nodeById(props.graph, edge.to)
              const d = () => {
                const from = source()
                const to = target()
                if (!from || !to) return ""
                return controlledPath(from.position, to.position, edge.meta?.controls)
              }
              const mid = () => {
                const from = source()
                const to = target()
                if (!from || !to) return null
                const sx = from.position.x + NODE_WIDTH / 2
                const tx = to.position.x + NODE_WIDTH / 2
                const sy = from.position.y + NODE_HEIGHT
                const ty = to.position.y
                return { x: (sx + tx) / 2, y: (sy + ty) / 2 + 4 }
              }
              const select = () => props.onSelect({ kind: "edge", id: edge.id })
              return (
                <>
                  <path
                    d={d()}
                    class="orch-edge-hit"
                    marker-end="none"
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      select()
                    }}
                  />
                  <path
                    d={d()}
                    classList={{
                      "orch-edge": true,
                      reprocess: edge.route.type === "reprocess",
                      selected: props.selected()?.kind === "edge" && props.selected()?.id === edge.id,
                      traversed: Number(props.run()?.edges[edge.id]?.traversals ?? 0) > 0,
                    }}
                    marker-end="url(#orch-arrow)"
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      select()
                    }}
                  />
                  <Show when={edge.route.type === "reprocess" && mid()}>
                    {(point) => (
                      <text
                        x={point().x}
                        y={point().y}
                        class="orch-edge-loop-label"
                        text-anchor="middle"
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          select()
                        }}
                      >
                        {`${Number(props.run()?.edges[edge.id]?.traversals ?? 0)}/${edge.route.maxTraversals ?? 1}`}
                      </text>
                    )}
                  </Show>
                  <Show when={props.selected()?.kind === "edge" && props.selected()?.id === edge.id}>
                    <For each={edge.meta?.controls ?? (source() && target() ? edgePoints(source()!.position, target()!.position) : [])}>
                      {(point, index) => (
                        <g
                          class="orch-edge-control"
                          transform={`translate(${point.x} ${point.y})`}
                          onPointerDown={(event) => dragControl(event, edge.id, index() as 0 | 1)}
                        >
                          <circle class="orch-edge-control-halo" r="10" />
                          <circle class="orch-edge-control-point" r="5" />
                        </g>
                      )}
                    </For>
                  </Show>
                </>
              )
            }}
          </For>
          <Show when={ghostFrom()}>{(path) => <path d={path()} class="orch-edge-ghost" />}</Show>
        </svg>

        <For each={props.graph.nodes}>
          {(node) => {
            const entry = () => props.graph.entryNodeId === node.id
            const output = () => props.graph.outputNodeId === node.id
            const selected = () => props.selected()?.kind === "node" && props.selected()?.id === node.id
            const name = () => nodeLabel(node)
            const isAgent = () => isAgentNode(node)
            const kindText = () => (isAgent() ? "agent" : "checkpoint")
            const agent = () => {
              if (!isAgentNode(node)) return null
              return node.capabilities.skills.length + node.capabilities.mcpServers.length > 0 ? node : null
            }
            return (
              <div
                data-node-id={node.id}
                class="orch-node"
                classList={{
                  selected: selected(),
                  entry: entry(),
                  output: output(),
                  checkpoint: !isAgent(),
                   unresolved: unresolved(node),
                   queued: nodeRun(node.id)?.status === "queued",
                   running: nodeRun(node.id)?.status === "running",
                   completed: nodeRun(node.id)?.status === "completed",
                   failed: nodeRun(node.id)?.status === "failed",
                   cancelled: nodeRun(node.id)?.status === "cancelled",
                   waiting: props.run()?.waiting?.nodeId === node.id,
                }}
                style={{
                  left: `${node.position.x}px`,
                  top: `${node.position.y}px`,
                  width: `${NODE_WIDTH}px`,
                }}
                onPointerDown={(e) => dragNode(e, node.id)}
              >
                <div class="orch-node-header">
                  <Show when={entry()}>
                    <Icon name="star-filled" size="small" />
                  </Show>
                  <Show when={output()}>
                    <Icon name="circle-check" size="small" />
                  </Show>
                  <Show when={unresolved(node)}>
                    <Icon name="warning" size="small" />
                  </Show>
                  <span class="orch-node-name" title={name()}>
                    {name()}
                  </span>
                </div>
                <div class="orch-node-kind">{kindText()}</div>
                <Show when={nodeRun(node.id)}>
                  {(state) => (
                    <div class="orch-node-run">
                      {state().status} · round {Number(state().round) + 1} · attempt {state().attempts}
                    </div>
                  )}
                </Show>
                <Show when={agent()}>
                  {(agentNode) => (
                    <div class="orch-node-badges">
                      <For each={agentNode().capabilities.skills}>
                        {(skill) => (
                          <span class="orch-badge">
                            <Icon name="star" size="small" />
                            <span class="text">{skill}</span>
                          </span>
                        )}
                      </For>
                      <For each={agentNode().capabilities.mcpServers}>
                        {(server) => (
                          <span class="orch-badge">
                            <Icon name="mcp" size="small" />
                            <span class="text">{server}</span>
                          </span>
                        )}
                      </For>
                    </div>
                  )}
                </Show>
                <div class="orch-handle in" />
                <div class="orch-handle out" onPointerDown={(e) => startConnect(e, node.id)} />
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}
