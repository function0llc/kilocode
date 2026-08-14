import { createMemo, createSignal, For, Show, type Component, type JSX } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Collapsible } from "@kilocode/kilo-ui/collapsible"
import { useOrchestrationData } from "./data"
import { useOrchestrationLanguage } from "./language"
import {
  PALETTE_DROP,
  PALETTE_END,
  PALETTE_MOVE,
  setDrag,
  type PaletteDragItem,
  type PalettePointerDetail,
} from "./types"

interface Props {
  onAddAgent: (agentName: string, kind: "agent" | "subagent") => void
  onAddCheckpoint: () => void
  onAttach: (kind: "skill" | "mcp", name: string) => void
}

export const Palette: Component<Props> = (props) => {
  const data = useOrchestrationData()
  const { t } = useOrchestrationLanguage()

  const agents = createMemo(() => data.agents().filter((agent) => agent.mode !== "subagent" && !agent.hidden))
  const subagents = createMemo(() => data.agents().filter((agent) => agent.mode === "subagent"))
  const skills = createMemo(() => data.skills())
  const servers = createMemo(() => Object.keys(data.mcpStatus()))
  const [ghost, setGhost] = createSignal<PalettePointerDetail | null>(null)
  let dragged = false

  const pointer = (event: PointerEvent, item: PaletteDragItem) => {
    if (event.button !== 0) return
    event.preventDefault()
    const start = { x: event.clientX, y: event.clientY }
    dragged = false
    setDrag(item)
    const move = (next: PointerEvent) => {
      if (!dragged && Math.abs(next.clientX - start.x) + Math.abs(next.clientY - start.y) < 4) return
      dragged = true
      const detail = { item, clientX: next.clientX, clientY: next.clientY }
      setGhost(detail)
      window.dispatchEvent(new CustomEvent<PalettePointerDetail>(PALETTE_MOVE, { detail }))
    }
    const up = (next: PointerEvent) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      const detail = { item, clientX: next.clientX, clientY: next.clientY }
      if (dragged) window.dispatchEvent(new CustomEvent<PalettePointerDetail>(PALETTE_DROP, { detail }))
      window.dispatchEvent(new CustomEvent(PALETTE_END))
      setGhost(null)
      setDrag(null)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const click = (action: () => void) => {
    if (dragged) {
      dragged = false
      return
    }
    action()
  }

  const section = (title: string, icon: Parameters<typeof Icon>[0]["name"], content: JSX.Element) => (
    <Collapsible class="orch-palette-section" variant="ghost" defaultOpen>
      <Collapsible.Trigger class="orch-palette-section-header">
        <Icon name={icon} size="small" />
        <span>{title}</span>
        <Collapsible.Arrow />
      </Collapsible.Trigger>
      <Collapsible.Content>{content}</Collapsible.Content>
    </Collapsible>
  )

  return (
    <aside class="orch-palette">
      <div class="orch-palette-hint">{t("orchestration.palette.hint")}</div>

      <div class="orch-palette-section orch-palette-controls">
        <div class="orch-palette-section-header">
          <Icon name="comment" size="small" />
          {t("orchestration.palette.controls")}
        </div>
        <div class="orch-palette-item orch-palette-action" onClick={() => props.onAddCheckpoint()}>
          <Icon name="comment" size="small" />
          <span class="label">{t("orchestration.palette.checkpoint")}</span>
        </div>
      </div>

      {section(
        t("orchestration.palette.agents"),
        "brain",
        <Show
          when={agents().length > 0}
          fallback={<div class="orch-palette-empty">{t("orchestration.palette.empty")}</div>}
        >
          <For each={agents()}>
            {(agent) => (
              <div
                class="orch-palette-item"
                onPointerDown={(event) => pointer(event, { kind: "agent", name: agent.name })}
                onClick={() => click(() => props.onAddAgent(agent.name, "agent"))}
                title={agent.description}
              >
                <Icon name="brain" size="small" />
                <span class="label">{agent.displayName || agent.name}</span>
              </div>
            )}
          </For>
        </Show>,
      )}

      {section(
        t("orchestration.palette.subagents"),
        "subagent",
        <Show
          when={subagents().length > 0}
          fallback={<div class="orch-palette-empty">{t("orchestration.palette.empty")}</div>}
        >
          <For each={subagents()}>
            {(agent) => (
              <div
                class="orch-palette-item"
                onPointerDown={(event) => pointer(event, { kind: "subagent", name: agent.name })}
                onClick={() => click(() => props.onAddAgent(agent.name, "subagent"))}
                title={agent.description}
              >
                <Icon name="subagent" size="small" />
                <span class="label">{agent.displayName || agent.name}</span>
              </div>
            )}
          </For>
        </Show>,
      )}

      {section(
        t("orchestration.palette.skills"),
        "star",
        <Show
          when={skills().length > 0}
          fallback={<div class="orch-palette-empty">{t("orchestration.palette.empty")}</div>}
        >
          <For each={skills()}>
            {(skill) => (
              <div
                class="orch-palette-item"
                onPointerDown={(event) => pointer(event, { kind: "skill", name: skill.name })}
                onClick={() => click(() => props.onAttach("skill", skill.name))}
                title={skill.description}
              >
                <Icon name="star" size="small" />
                <span class="label">{skill.name}</span>
              </div>
            )}
          </For>
        </Show>,
      )}

      {section(
        t("orchestration.palette.mcp"),
        "mcp",
        <Show
          when={servers().length > 0}
          fallback={<div class="orch-palette-empty">{t("orchestration.palette.empty")}</div>}
        >
          <For each={servers()}>
            {(name) => (
              <div
                class="orch-palette-item"
                onPointerDown={(event) => pointer(event, { kind: "mcp", name })}
                onClick={() => click(() => props.onAttach("mcp", name))}
              >
                <Icon name="mcp" size="small" />
                <span class="label">{name}</span>
              </div>
            )}
          </For>
        </Show>,
      )}
      <Show when={ghost()}>
        {(current) => (
          <div
            class="orch-palette-drag-outline"
            classList={{ capability: current().item.kind === "skill" || current().item.kind === "mcp" }}
            style={{ left: `${current().clientX}px`, top: `${current().clientY}px` }}
          >
            <Icon
              name={
                current().item.kind === "subagent"
                  ? "subagent"
                  : current().item.kind === "mcp"
                    ? "mcp"
                    : current().item.kind === "skill"
                      ? "star"
                      : "brain"
              }
              size="small"
            />
            <span>{current().item.name}</span>
          </div>
        )}
      </Show>
    </aside>
  )
}
