import { createMemo, For, Show, type Accessor, type Component, type JSX } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { ModelSelectorBase } from "../src/components/shared/ModelSelector"
import { useProvider } from "../src/context/provider"
import { agentRole, createId, isAgentNode, isCheckpointNode, nodeById, nodeLabel } from "../../src/orchestration/domain"
import type {
  AgentNode,
  CheckpointDisplay,
  CheckpointInput,
  CheckpointNode,
  NodeOverrides,
  OrchestrationEdge,
  OrchestrationGraph,
} from "../../src/orchestration/domain"
import type { AgentInfo } from "../src/types/messages"
import { useOrchestrationData } from "./data"
import { useOrchestrationLanguage } from "./language"
import type { Selection } from "./types"

interface Props {
  graph: OrchestrationGraph
  selected: () => Selection | null
  onSetEntry: (nodeId: string) => void
  onSetOutput: (nodeId: string) => void
  onRemoveNode: (nodeId: string) => void
  onRemoveEdge: (edgeId: string) => void
  onRemoveCapability: (nodeId: string, kind: "skill" | "mcp", name: string) => void
  mutate: (fn: (graph: OrchestrationGraph) => void) => void
}

const Field: Component<{ label: string; children: JSX.Element }> = (props) => (
  <label class="orch-inspector-field">
    <span class="orch-inspector-label">{props.label}</span>
    {props.children}
  </label>
)

const numberValue = (value: number | null | undefined): string | undefined =>
  value === null || value === undefined ? undefined : String(value)

export const Inspector: Component<Props> = (props) => {
  const { t } = useOrchestrationLanguage()

  const selectedNode = createMemo(() => {
    const sel = props.selected()
    if (sel?.kind !== "node") return null
    return nodeById(props.graph, sel.id) ?? null
  })

  const selectedEdge = createMemo(() => {
    const sel = props.selected()
    if (sel?.kind !== "edge") return null
    return props.graph.edges.find((edge) => edge.id === sel.id) ?? null
  })

  const agentNode = createMemo<AgentNode | null>(() => {
    const node = selectedNode()
    return node && isAgentNode(node) ? node : null
  })

  const checkpointNode = createMemo<CheckpointNode | null>(() => {
    const node = selectedNode()
    return node && isCheckpointNode(node) ? node : null
  })

  return (
    <aside class="orch-inspector">
      <h2>{t("orchestration.inspector.title")}</h2>

      <Show when={!selectedNode() && !selectedEdge()}>
        <div class="orch-inspector-empty">{t("orchestration.inspector.selectNode")}</div>
      </Show>

      <Show when={agentNode()}>{(node) => <AgentInspector node={node} {...props} />}</Show>

      <Show when={checkpointNode()}>{(node) => <CheckpointInspector node={node} {...props} />}</Show>

      <Show when={selectedEdge()}>{(edge) => <EdgeInspector edge={edge} {...props} />}</Show>
    </aside>
  )
}

interface SubProps extends Props {
  onRemoveNode: (nodeId: string) => void
  onRemoveEdge: (edgeId: string) => void
  onRemoveCapability: (nodeId: string, kind: "skill" | "mcp", name: string) => void
  mutate: (fn: (graph: OrchestrationGraph) => void) => void
}

const AgentInspector: Component<{ node: Accessor<AgentNode> } & SubProps> = (props) => {
  const data = useOrchestrationData()
  const provider = useProvider()
  const { t } = useOrchestrationLanguage()
  const node = () => props.node()

  const agentInfo = createMemo<AgentInfo | null>(() => {
    return data.agents().find((agent) => agent.name === node().source.agentName) ?? null
  })

  const unresolved = createMemo(() => {
    const roster = data.agents()
    return roster.length > 0 && !roster.some((agent) => agent.name === node().source.agentName)
  })

  const actions = useOverrideActions(node, props.mutate)

  const modelSelection = createMemo(() => {
    const override = node().overrides.model
    if (override) return override
    return agentInfo()?.model ?? null
  })

  const sourceModel = createMemo(() => agentInfo()?.model ?? null)

  const variantOptions = createMemo(() => {
    const selection = modelSelection()
    if (!selection) return []
    const model = provider.findModel(selection)
    return Object.keys(model?.variants ?? {})
  })

  return (
    <>
      <Show when={unresolved()}>
        <div class="orch-inspector-warning">
          <Icon name="warning" size="small" />
          <span>{t("orchestration.inspector.unresolved")}</span>
        </div>
      </Show>

      <SourceSection node={node} agentInfo={agentInfo} />
      <IdentitySection node={node} actions={actions} />
      <ModelSection
        node={node}
        agentInfo={agentInfo}
        actions={actions}
        modelSelection={modelSelection}
        sourceModel={sourceModel}
        variantOptions={variantOptions}
      />
      <PromptSection node={node} actions={actions} />
      <CapabilitiesSection node={node} onRemoveCapability={props.onRemoveCapability} />
      <RuntimeSection node={node} actions={actions} />

      <NodeActions
        nodeId={node().id}
        graph={props.graph}
        onSetEntry={props.onSetEntry}
        onSetOutput={props.onSetOutput}
        onRemoveNode={props.onRemoveNode}
      />
    </>
  )
}

type OverrideActions = {
  setOverride: (key: keyof NodeOverrides, value: unknown) => void
  clearOverride: (key: keyof NodeOverrides) => void
  setRuntime: (key: "timeoutMs" | "retries" | "failure" | "includeInFinalOutput", value: unknown) => void
}

function useOverrideActions(
  node: Accessor<AgentNode>,
  mutate: (fn: (graph: OrchestrationGraph) => void) => void,
): OverrideActions {
  const setOverride = (key: keyof NodeOverrides, value: unknown) => {
    mutate((g) => {
      const target = g.nodes.find((item) => item.id === node().id)
      if (!target || !isAgentNode(target)) return
      ;(target.overrides as Record<string, unknown>)[key] = value
    })
  }
  const clearOverride = (key: keyof NodeOverrides) => {
    mutate((g) => {
      const target = g.nodes.find((item) => item.id === node().id)
      if (!target || !isAgentNode(target)) return
      delete target.overrides[key]
    })
  }
  const setRuntime = (key: "timeoutMs" | "retries" | "failure" | "includeInFinalOutput", value: unknown) => {
    mutate((g) => {
      const target = g.nodes.find((item) => item.id === node().id)
      if (!target || !isAgentNode(target)) return
      ;(target.runtime as Record<string, unknown>)[key] = value
    })
  }
  return { setOverride, clearOverride, setRuntime }
}

const SourceSection: Component<{ node: Accessor<AgentNode>; agentInfo: Accessor<AgentInfo | null> }> = (props) => {
  const { t } = useOrchestrationLanguage()
  return (
    <>
      <div class="orch-inspector-section">
        <div class="orch-inspector-label">{t("orchestration.inspector.agent")}</div>
        <div class="orch-inspector-value">{props.node().source.agentName}</div>
        <Show when={props.agentInfo()?.description}>
          <div class="orch-inspector-desc">{props.agentInfo()?.description}</div>
        </Show>
      </div>
      <div class="orch-inspector-section">
        <div class="orch-inspector-label">{t("orchestration.inspector.type")}</div>
        <div class="orch-inspector-value">
          {props.agentInfo()
            ? t(`orchestration.agent.${agentRole(props.agentInfo()) ?? "agent"}`)
            : t("orchestration.inspector.unresolvedShort")}
        </div>
      </div>
    </>
  )
}

const IdentitySection: Component<{ node: Accessor<AgentNode>; actions: OverrideActions }> = (props) => {
  const { t } = useOrchestrationLanguage()
  return (
    <div class="orch-inspector-section">
      <Field label={t("orchestration.inspector.displayName")}>
        <input
          class="orch-inspector-input"
          placeholder={props.node().source.agentName}
          value={props.node().overrides.displayName ?? ""}
          onInput={(e) => props.actions.setOverride("displayName", (e.target as HTMLInputElement).value || null)}
        />
      </Field>
      <Field label={t("orchestration.inspector.nodeDescription")}>
        <textarea
          class="orch-inspector-textarea"
          rows={2}
          value={props.node().overrides.description ?? ""}
          onInput={(e) => props.actions.setOverride("description", (e.target as HTMLTextAreaElement).value || null)}
        />
      </Field>
    </div>
  )
}

const ModelSection: Component<{
  node: Accessor<AgentNode>
  agentInfo: Accessor<AgentInfo | null>
  actions: OverrideActions
  modelSelection: Accessor<{ providerID: string; modelID: string } | null>
  sourceModel: Accessor<{ providerID: string; modelID: string } | null>
  variantOptions: Accessor<string[]>
}> = (props) => {
  const { t } = useOrchestrationLanguage()
  const { setOverride, clearOverride } = props.actions
  return (
    <div class="orch-inspector-section">
      <div class="orch-inspector-label">{t("orchestration.inspector.model")}</div>
      <ModelSelectorBase
        value={props.modelSelection()}
        onSelect={(providerID, modelID) => {
          if (!providerID || !modelID) {
            if (props.sourceModel()) setOverride("model", null)
            else clearOverride("model")
            return
          }
          setOverride("model", { providerID, modelID })
        }}
        placement="bottom-start"
        allowClear
        clearLabel={t("orchestration.inspector.inheritModel")}
      />
      <Show when={props.variantOptions().length > 0 || props.node().overrides.variant}>
        <Field label={t("orchestration.inspector.variant")}>
          <select
            class="orch-inspector-select"
            value={props.node().overrides.variant ?? props.agentInfo()?.variant ?? ""}
            onChange={(e) => {
              const value = (e.target as HTMLSelectElement).value
              if (value === "") {
                if (props.agentInfo()?.variant) setOverride("variant", null)
                else clearOverride("variant")
              } else {
                setOverride("variant", value)
              }
            }}
          >
            <option value="">{t("orchestration.inspector.inherit")}</option>
            <For each={props.variantOptions()}>{(variant) => <option value={variant}>{variant}</option>}</For>
          </select>
        </Field>
      </Show>
      <Field label={t("orchestration.inspector.temperature")}>
        <input
          class="orch-inspector-input"
          type="number"
          step="0.1"
          min="0"
          max="2"
          placeholder={
            props.agentInfo()?.temperature !== undefined
              ? String(props.agentInfo()!.temperature)
              : t("orchestration.inspector.inherit")
          }
          value={numberValue(props.node().overrides.temperature) ?? ""}
          onInput={(e) => {
            const value = (e.target as HTMLInputElement).value
            setOverride("temperature", value === "" ? null : Number(value))
          }}
        />
      </Field>
      <Field label={t("orchestration.inspector.topP")}>
        <input
          class="orch-inspector-input"
          type="number"
          step="0.1"
          min="0"
          max="1"
          placeholder={
            props.agentInfo()?.topP !== undefined
              ? String(props.agentInfo()!.topP)
              : t("orchestration.inspector.inherit")
          }
          value={numberValue(props.node().overrides.topP) ?? ""}
          onInput={(e) => {
            const value = (e.target as HTMLInputElement).value
            setOverride("topP", value === "" ? null : Number(value))
          }}
        />
      </Field>
      <Field label={t("orchestration.inspector.steps")}>
        <input
          class="orch-inspector-input"
          type="number"
          step="1"
          min="1"
          placeholder={
            props.agentInfo()?.steps !== undefined
              ? String(props.agentInfo()!.steps)
              : t("orchestration.inspector.inherit")
          }
          value={numberValue(props.node().overrides.steps) ?? ""}
          onInput={(e) => {
            const value = (e.target as HTMLInputElement).value
            setOverride("steps", value === "" ? null : Number(value))
          }}
        />
      </Field>
    </div>
  )
}

const PromptSection: Component<{ node: Accessor<AgentNode>; actions: OverrideActions }> = (props) => {
  const { t } = useOrchestrationLanguage()
  const { setOverride, clearOverride } = props.actions
  return (
    <div class="orch-inspector-section">
      <Field label={t("orchestration.inspector.promptMode")}>
        <select
          class="orch-inspector-select"
          value={props.node().overrides.prompt?.mode ?? "inherit"}
          onChange={(e) => {
            const mode = (e.target as HTMLSelectElement).value as "inherit" | "append" | "replace"
            if (mode === "inherit") clearOverride("prompt")
            else setOverride("prompt", { mode, text: props.node().overrides.prompt?.text ?? "" })
          }}
        >
          <option value="inherit">{t("orchestration.inspector.promptInherit")}</option>
          <option value="append">{t("orchestration.inspector.promptAppend")}</option>
          <option value="replace">{t("orchestration.inspector.promptReplace")}</option>
        </select>
      </Field>
      <Show when={props.node().overrides.prompt?.mode && props.node().overrides.prompt!.mode !== "inherit"}>
        <Field label={t("orchestration.inspector.promptText")}>
          <textarea
            class="orch-inspector-textarea"
            rows={6}
            value={props.node().overrides.prompt?.text ?? ""}
            onInput={(e) => {
              const text = (e.target as HTMLTextAreaElement).value
              const mode = props.node().overrides.prompt?.mode ?? "append"
              setOverride("prompt", { mode, text })
            }}
          />
        </Field>
      </Show>
    </div>
  )
}

const CapabilitiesSection: Component<{
  node: Accessor<AgentNode>
  onRemoveCapability: (nodeId: string, kind: "skill" | "mcp", name: string) => void
}> = (props) => {
  const { t } = useOrchestrationLanguage()
  return (
    <div class="orch-inspector-section">
      <div class="orch-inspector-label">{t("orchestration.inspector.capabilities")}</div>
      <Show
        when={props.node().capabilities.skills.length + props.node().capabilities.mcpServers.length > 0}
        fallback={<div class="orch-inspector-empty">{t("orchestration.inspector.noCapabilities")}</div>}
      >
        <For each={props.node().capabilities.skills}>
          {(skill) => (
            <div class="orch-inspector-cap">
              <span class="label">
                <Icon name="star" size="small" />
                <span class="text">{skill}</span>
              </span>
              <IconButton
                size="small"
                variant="ghost"
                icon="close"
                onClick={() => props.onRemoveCapability(props.node().id, "skill", skill)}
              />
            </div>
          )}
        </For>
        <For each={props.node().capabilities.mcpServers}>
          {(server) => (
            <div class="orch-inspector-cap">
              <span class="label">
                <Icon name="mcp" size="small" />
                <span class="text">{server}</span>
              </span>
              <IconButton
                size="small"
                variant="ghost"
                icon="close"
                onClick={() => props.onRemoveCapability(props.node().id, "mcp", server)}
              />
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

const RuntimeSection: Component<{ node: Accessor<AgentNode>; actions: OverrideActions }> = (props) => {
  const { t } = useOrchestrationLanguage()
  return (
    <div class="orch-inspector-section">
      <div class="orch-inspector-label">{t("orchestration.inspector.runtime")}</div>
      <Field label={t("orchestration.inspector.retries")}>
        <input
          class="orch-inspector-input"
          type="number"
          step="1"
          min="0"
          value={props.node().runtime.retries ?? 0}
          onInput={(e) => props.actions.setRuntime("retries", Number((e.target as HTMLInputElement).value) || 0)}
        />
      </Field>
      <Field label={t("orchestration.inspector.failurePolicy")}>
        <select
          class="orch-inspector-select"
          value={props.node().runtime.failure}
          onChange={(e) => props.actions.setRuntime("failure", (e.target as HTMLSelectElement).value)}
        >
          <option value="stop">{t("orchestration.inspector.failureStop")}</option>
          <option value="continue">{t("orchestration.inspector.failureContinue")}</option>
        </select>
      </Field>
      <Field label={t("orchestration.inspector.timeoutMs")}>
        <input
          class="orch-inspector-input"
          type="number"
          step="1000"
          min="0"
          placeholder={t("orchestration.inspector.inherit")}
          value={numberValue(props.node().runtime.timeoutMs) ?? ""}
          onInput={(e) => {
            const value = (e.target as HTMLInputElement).value
            props.actions.setRuntime("timeoutMs", value === "" ? undefined : Number(value) || undefined)
          }}
        />
      </Field>
    </div>
  )
}

const CheckpointInspector: Component<{ node: Accessor<CheckpointNode> } & SubProps> = (props) => {
  const { t } = useOrchestrationLanguage()
  const node = () => props.node()

  const setCheckpoint = (
    patch: Partial<{
      prompt: string
      options: Array<{ id: string; label: string }>
      display: CheckpointDisplay
      input: CheckpointInput
    }>,
  ) => {
    props.mutate((g) => {
      const target = g.nodes.find((item) => item.id === node().id)
      if (!target || !isCheckpointNode(target)) return
      if (typeof patch.prompt === "string") target.prompt = patch.prompt
      if (patch.options) target.options = patch.options
      if (patch.display) target.display = patch.display
      if (patch.input) target.input = patch.input
    })
  }

  const addOption = () => {
    const next = [...node().options, { id: createId("opt"), label: t("orchestration.inspector.optionNew") }]
    setCheckpoint({ options: next })
  }

  const removeOption = (id: string) => {
    setCheckpoint({ options: node().options.filter((option) => option.id !== id) })
  }

  const setOptionLabel = (id: string, label: string) => {
    setCheckpoint({ options: node().options.map((option) => (option.id === id ? { ...option, label } : option)) })
  }

  return (
    <>
      <div class="orch-inspector-section">
        <div class="orch-inspector-label">{t("orchestration.inspector.checkpoint")}</div>
        <div class="orch-inspector-desc">{t("orchestration.inspector.checkpointHint")}</div>
        <Field label={t("orchestration.inspector.checkpointPrompt")}>
          <textarea
            class="orch-inspector-textarea"
            rows={4}
            placeholder={t("orchestration.inspector.checkpointPromptPlaceholder")}
            value={node().prompt}
            onInput={(e) => setCheckpoint({ prompt: (e.target as HTMLTextAreaElement).value })}
          />
        </Field>
      </div>

      <div class="orch-inspector-section">
        <div class="orch-inspector-label">{t("orchestration.inspector.outcomes")}</div>
        <For each={node().options}>
          {(option) => (
            <div class="orch-inspector-cap">
              <input
                class="orch-inspector-input"
                value={option.label}
                onInput={(e) => setOptionLabel(option.id, (e.target as HTMLInputElement).value)}
              />
              <IconButton size="small" variant="ghost" icon="close" onClick={() => removeOption(option.id)} />
            </div>
          )}
        </For>
        <Button size="small" variant="secondary" icon="plus" onClick={addOption}>
          {t("orchestration.inspector.addOutcome")}
        </Button>
      </div>

      <div class="orch-inspector-section">
        <div class="orch-inspector-label">{t("orchestration.inspector.checkpointDisplay")}</div>
        <Field label={t("orchestration.inspector.displayMode")}>
          <select
            class="orch-inspector-select"
            value={node().display?.mode ?? "predecessors"}
            onChange={(e) => {
              const mode = (e.target as HTMLSelectElement).value as "none" | "predecessors"
              setCheckpoint({ display: { mode, ...(node().display?.title ? { title: node().display!.title } : {}) } })
            }}
          >
            <option value="predecessors">{t("orchestration.inspector.displayPredecessors")}</option>
            <option value="none">{t("orchestration.inspector.displayNone")}</option>
          </select>
        </Field>
        <Show when={(node().display?.mode ?? "predecessors") === "predecessors"}>
          <Field label={t("orchestration.inspector.displayTitle")}>
            <input
              class="orch-inspector-input"
              value={node().display?.title ?? ""}
              placeholder={t("orchestration.inspector.displayTitlePlaceholder")}
              onInput={(e) => {
                const title = (e.target as HTMLInputElement).value
                setCheckpoint({ display: { mode: "predecessors", ...(title ? { title } : {}) } })
              }}
            />
          </Field>
        </Show>
      </div>

      <div class="orch-inspector-section">
        <div class="orch-inspector-label">{t("orchestration.inspector.checkpointInput")}</div>
        <Field label={t("orchestration.inspector.inputMode")}>
          <select
            class="orch-inspector-select"
            value={node().input?.mode ?? "optional"}
            onChange={(e) => {
              const mode = (e.target as HTMLSelectElement).value as "none" | "optional" | "required"
              setCheckpoint({
                input: { mode, ...(node().input?.placeholder ? { placeholder: node().input!.placeholder } : {}) },
              })
            }}
          >
            <option value="optional">{t("orchestration.inspector.inputOptional")}</option>
            <option value="required">{t("orchestration.inspector.inputRequired")}</option>
            <option value="none">{t("orchestration.inspector.inputNone")}</option>
          </select>
        </Field>
        <Show when={(node().input?.mode ?? "optional") !== "none"}>
          <Field label={t("orchestration.inspector.inputPlaceholder")}>
            <input
              class="orch-inspector-input"
              value={node().input?.placeholder ?? ""}
              placeholder={t("orchestration.inspector.inputPlaceholderValue")}
              onInput={(e) => {
                const placeholder = (e.target as HTMLInputElement).value
                setCheckpoint({
                  input: { mode: node().input?.mode ?? "optional", ...(placeholder ? { placeholder } : {}) },
                })
              }}
            />
          </Field>
        </Show>
      </div>

      <NodeActions
        nodeId={node().id}
        graph={props.graph}
        onSetEntry={props.onSetEntry}
        onSetOutput={props.onSetOutput}
        onRemoveNode={props.onRemoveNode}
      />
    </>
  )
}

const NodeActions: Component<{
  nodeId: string
  graph: OrchestrationGraph
  onSetEntry: (nodeId: string) => void
  onSetOutput: (nodeId: string) => void
  onRemoveNode: (nodeId: string) => void
}> = (props) => {
  const { t } = useOrchestrationLanguage()
  return (
    <div class="orch-inspector-actions">
      <Show when={props.graph.entryNodeId === props.nodeId}>
        <div class="orch-inspector-value">
          <Icon name="star-filled" size="small" /> {t("orchestration.inspector.entry")}
        </div>
      </Show>
      <Show when={props.graph.entryNodeId !== props.nodeId}>
        <Button size="small" variant="secondary" icon="star" onClick={() => props.onSetEntry(props.nodeId)}>
          {t("orchestration.inspector.setEntry")}
        </Button>
      </Show>
      <Show when={props.graph.outputNodeId === props.nodeId}>
        <div class="orch-inspector-value">
          <Icon name="circle-check" size="small" /> {t("orchestration.inspector.output")}
        </div>
      </Show>
      <Show when={props.graph.outputNodeId !== props.nodeId}>
        <Button size="small" variant="secondary" icon="circle-check" onClick={() => props.onSetOutput(props.nodeId)}>
          {t("orchestration.inspector.setOutput")}
        </Button>
      </Show>
      <Button size="small" variant="ghost" icon="trash" onClick={() => props.onRemoveNode(props.nodeId)}>
        {t("orchestration.inspector.removeNode")}
      </Button>
    </div>
  )
}

const EdgeInspector: Component<{ edge: Accessor<OrchestrationEdge> } & SubProps> = (props) => {
  const { t } = useOrchestrationLanguage()
  const edge = () => props.edge()

  const fromCheckpoint = createMemo(() => {
    const node = nodeById(props.graph, edge().from)
    return node && isCheckpointNode(node) ? node : null
  })

  const nodeName = (id: string) => {
    const node = nodeById(props.graph, id)
    return node ? nodeLabel(node) : "?"
  }

  const setEdgeRoute = (
    patch: Partial<{
      type: "forward" | "reprocess"
      outcome?: string | null
      maxTraversals?: number | null
      onLimit?: "continue" | "stop" | "fail" | null
    }>,
  ) => {
    props.mutate((g) => {
      const target = g.edges.find((item) => item.id === edge().id)
      if (!target) return
      if (patch.type) target.route.type = patch.type
      if (patch.outcome !== undefined) {
        if (patch.outcome === null) delete target.route.outcome
        else target.route.outcome = patch.outcome
      }
      if (patch.maxTraversals !== undefined) {
        if (patch.maxTraversals === null) delete target.route.maxTraversals
        else target.route.maxTraversals = patch.maxTraversals
      }
      if (patch.onLimit !== undefined) {
        if (patch.onLimit === null) delete target.route.onLimit
        else target.route.onLimit = patch.onLimit
      }
    })
  }

  return (
    <>
      <div class="orch-inspector-section">
        <div class="orch-inspector-label">
          {nodeName(edge().from)} → {nodeName(edge().to)}
        </div>
        <Field label={t("orchestration.inspector.connectionType")}>
          <select
            class="orch-inspector-select"
            value={edge().route.type}
            onChange={(e) => {
              const type = (e.target as HTMLSelectElement).value as "forward" | "reprocess"
              if (type === "reprocess") {
                setEdgeRoute({ type, maxTraversals: edge().route.maxTraversals ?? 2 })
              } else {
                setEdgeRoute({ type })
              }
            }}
          >
            <option value="forward">{t("orchestration.inspector.forward")}</option>
            <option value="reprocess">{t("orchestration.inspector.reprocess")}</option>
          </select>
        </Field>
        <Show when={fromCheckpoint() && fromCheckpoint()!.options.length > 0}>
          <Field label={t("orchestration.inspector.outcome")}>
            <select
              class="orch-inspector-select"
              value={edge().route.outcome ?? ""}
              onChange={(e) => {
                const value = (e.target as HTMLSelectElement).value
                setEdgeRoute({ outcome: value === "" ? null : value })
              }}
            >
              <option value="">{t("orchestration.inspector.outcomeNone")}</option>
              <For each={fromCheckpoint()!.options}>
                {(option) => <option value={option.id}>{option.label}</option>}
              </For>
            </select>
          </Field>
        </Show>
        <Show when={edge().route.type === "reprocess"}>
          <Field label={t("orchestration.inspector.maxTraversals")}>
            <input
              class="orch-inspector-input"
              type="number"
              step="1"
              min="1"
              value={edge().route.maxTraversals ?? ""}
              onInput={(e) => {
                const value = (e.target as HTMLInputElement).value
                setEdgeRoute({ maxTraversals: value === "" ? null : Number(value) || null })
              }}
            />
          </Field>
          <Field label={t("orchestration.inspector.onLimit")}>
            <select
              class="orch-inspector-select"
              value={edge().route.onLimit ?? "continue"}
              onChange={(e) => {
                const value = (e.target as HTMLSelectElement).value as "continue" | "stop" | "fail"
                setEdgeRoute({ onLimit: value === "continue" ? null : value })
              }}
            >
              <option value="continue">{t("orchestration.inspector.onLimitContinue")}</option>
              <option value="stop">{t("orchestration.inspector.onLimitStop")}</option>
              <option value="fail">{t("orchestration.inspector.onLimitFail")}</option>
            </select>
          </Field>
        </Show>
      </div>
      <div class="orch-inspector-actions">
        <Button size="small" variant="ghost" icon="trash" onClick={() => props.onRemoveEdge(edge().id)}>
          {t("orchestration.inspector.removeEdge")}
        </Button>
      </div>
    </>
  )
}
