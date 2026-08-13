import { Orchestration } from "@/kilocode/orchestration/service"
import type { CheckpointPayload, RunID, StartPayload } from "@/kilocode/orchestration/api"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { OrchestrationGraph } from "@/kilocode/orchestration/domain"

export const orchestrationHandlers = HttpApiBuilder.group(InstanceHttpApi, "orchestration", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Orchestration.Service
    return handlers
      .handle("start", (ctx: { payload: typeof StartPayload.Type }) =>
        svc.start({ ...ctx.payload, graph: structuredClone(ctx.payload.graph) as OrchestrationGraph }),
      )
      .handle("get", (ctx: { params: { runID: RunID } }) => svc.get(ctx.params.runID))
      .handle("cancel", (ctx: { params: { runID: RunID } }) => svc.cancel(ctx.params.runID))
      .handle("checkpoint", (ctx: { params: { runID: RunID }; payload: typeof CheckpointPayload.Type }) =>
        svc.checkpoint({ runID: ctx.params.runID, ...ctx.payload }),
      )
  }),
)
