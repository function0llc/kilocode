import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"

export const RunID = Schema.String.pipe(Schema.brand("OrchestrationRunID"))
export type RunID = typeof RunID.Type

const Position = Schema.Struct({ x: Schema.Number, y: Schema.Number })
const Model = Schema.Struct({ providerID: Schema.String, modelID: Schema.String })
const Rule = Schema.Struct({
  permission: Schema.String,
  pattern: Schema.optional(Schema.String),
  action: Schema.Literals(["allow", "ask", "deny"]),
})
const Prompt = Schema.Struct({ mode: Schema.Literals(["inherit", "append", "replace"]), text: Schema.optional(Schema.String) })
const Overrides = Schema.Struct({
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(Model)),
  variant: Schema.optional(Schema.NullOr(Schema.String)),
  prompt: Schema.optional(Prompt),
  temperature: Schema.optional(Schema.NullOr(Schema.Number)),
  topP: Schema.optional(Schema.NullOr(Schema.Number)),
  steps: Schema.optional(Schema.NullOr(Schema.Number)),
  permission: Schema.optional(Schema.Array(Rule)),
})
const Runtime = Schema.Struct({
  timeoutMs: Schema.optional(Schema.Number),
  retries: Schema.optional(Schema.Number),
  failure: Schema.Literals(["stop", "continue"]),
  includeInFinalOutput: Schema.optional(Schema.Boolean),
})
const AgentNode = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("agent"),
  source: Schema.Struct({ agentName: Schema.String }),
  position: Position,
  overrides: Overrides,
  capabilities: Schema.Struct({ skills: Schema.Array(Schema.String), mcpServers: Schema.Array(Schema.String) }),
  runtime: Runtime,
})
const CheckpointNode = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("checkpoint"),
  position: Position,
  prompt: Schema.String,
  options: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
})
const Edge = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  to: Schema.String,
  route: Schema.Struct({
    type: Schema.Literals(["forward", "reprocess"]),
    outcome: Schema.optional(Schema.String),
    maxTraversals: Schema.optional(Schema.Number),
    onLimit: Schema.optional(Schema.Literals(["continue", "stop", "fail"])),
  }),
})

export const Graph = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.Literal(2),
  entryNodeId: Schema.NullOr(Schema.String),
  outputNodeId: Schema.NullOr(Schema.String),
  nodes: Schema.Array(Schema.Union([AgentNode, CheckpointNode])),
  edges: Schema.Array(Edge),
  updatedAt: Schema.String,
})

const NodeRun = Schema.Struct({
  nodeId: Schema.String,
  round: Schema.Number,
  status: Schema.Literals(["queued", "running", "completed", "failed", "cancelled"]),
  attempts: Schema.Number,
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Number),
  finishedAt: Schema.optional(Schema.Number),
})

export const Run = Schema.Struct({
  id: Schema.String,
  graphId: Schema.String,
  graphName: Schema.String,
  graph: Graph,
  directory: Schema.optional(Schema.String),
  status: Schema.Literals(["running", "waiting-for-user", "completed", "failed", "cancelled"]),
  input: Schema.String,
  nodes: Schema.Record(Schema.String, Schema.Array(NodeRun)),
  edges: Schema.Record(Schema.String, Schema.Struct({ traversals: Schema.Number })),
  checkpoints: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({ round: Schema.Number, outcome: Schema.String, feedback: Schema.optional(Schema.String) }),
    ),
  ),
  waiting: Schema.optional(
    Schema.Struct({
      nodeId: Schema.String,
      round: Schema.Number,
      prompt: Schema.String,
      options: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
    }),
  ),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  revision: Schema.Number,
  error: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
})

export const StartPayload = Schema.Struct({ graph: Graph, input: Schema.String, concurrency: Schema.optional(Schema.Number) })
export const CheckpointPayload = Schema.Struct({
  nodeId: Schema.String,
  outcome: Schema.String,
  feedback: Schema.optional(Schema.String),
})
export const RunParams = Schema.Struct({ runID: RunID })

export class InvalidGraphError extends Schema.TaggedErrorClass<InvalidGraphError>()("OrchestrationInvalidGraphError", {
  issues: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      nodeId: Schema.optional(Schema.String),
      edgeId: Schema.optional(Schema.String),
    }),
  ),
}) {}

export class RunNotFoundError extends Schema.TaggedErrorClass<RunNotFoundError>()("OrchestrationRunNotFoundError", {
  runID: RunID,
  message: Schema.String,
}) {}

export class InvalidCheckpointError extends Schema.TaggedErrorClass<InvalidCheckpointError>()(
  "OrchestrationInvalidCheckpointError",
  { runID: RunID, message: Schema.String },
) {}

export const Event = {
  Updated: BusEvent.define(
    "orchestration.run.updated",
    Schema.Struct({
      runID: RunID,
      revision: Schema.Number,
      event: Schema.String,
      status: Schema.Literals(["running", "waiting-for-user", "completed", "failed", "cancelled"]),
    }),
  ),
}
