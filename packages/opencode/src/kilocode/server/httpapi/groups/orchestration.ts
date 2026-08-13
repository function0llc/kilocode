import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { CheckpointPayload, InvalidCheckpointError, InvalidGraphError, Run, RunNotFoundError, RunParams, StartPayload } from "@/kilocode/orchestration/api"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

const root = "/kilocode/orchestration/run"

export const OrchestrationApi = HttpApi.make("orchestration-api")
  .add(
    HttpApiGroup.make("orchestration")
      .add(
        HttpApiEndpoint.post("start", root, {
          query: WorkspaceRoutingQuery,
          payload: StartPayload,
          success: described(Run, "Orchestration run"),
          error: InvalidGraphError,
        }).annotateMerge(OpenApi.annotations({ identifier: "orchestration.start", summary: "Start orchestration run" })),
        HttpApiEndpoint.get("get", `${root}/:runID`, {
          params: RunParams,
          query: WorkspaceRoutingQuery,
          success: described(Run, "Orchestration run"),
          error: RunNotFoundError,
        }).annotateMerge(OpenApi.annotations({ identifier: "orchestration.get", summary: "Get orchestration run" })),
        HttpApiEndpoint.post("cancel", `${root}/:runID/cancel`, {
          params: RunParams,
          query: WorkspaceRoutingQuery,
          success: described(Run, "Cancelled orchestration run"),
          error: RunNotFoundError,
        }).annotateMerge(OpenApi.annotations({ identifier: "orchestration.cancel", summary: "Cancel orchestration run" })),
        HttpApiEndpoint.post("checkpoint", `${root}/:runID/checkpoint`, {
          params: RunParams,
          query: WorkspaceRoutingQuery,
          payload: CheckpointPayload,
          success: described(Run, "Resumed orchestration run"),
          error: [RunNotFoundError, InvalidCheckpointError],
        }).annotateMerge(OpenApi.annotations({ identifier: "orchestration.checkpoint", summary: "Resolve orchestration checkpoint" })),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
