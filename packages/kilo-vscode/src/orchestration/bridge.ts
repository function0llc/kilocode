import type { KiloClient, OrchestrationStartData } from "@kilocode/sdk/v2"
import { getErrorMessage } from "../kilo-provider-utils"
import type { OrchestrationRequest } from "./messages"
import { validateGraph, type OrchestrationGraph } from "./domain"
import { deleteGraph, duplicateGraph, listGraphs, persistGraph, readGraph, renameGraph } from "./graph-storage"
import { buildAgentConfigFromGraph, PublishError, syncPublishedAgent, unpublishGraph } from "./publish"

type Options = {
  client: () => KiloClient
  directory: () => string
  configDir: () => Promise<string>
  agents: () => Promise<string[] | undefined>
  post: (message: unknown) => void
  refreshAgents?: () => Promise<void>
}

export class OrchestrationBridge {
  runId: string | undefined

  constructor(private readonly opts: Options) {}

  async handle(message: OrchestrationRequest): Promise<void> {
    try {
      switch (message.type) {
        case "orchestration.listGraphs":
          return await this.graphs()
        case "orchestration.loadGraph":
          return await this.load(message.graphId)
        case "orchestration.saveGraph":
          return await this.save(message.graph, message.existing)
        case "orchestration.deleteGraph":
          return await this.remove(message.graphId)
        case "orchestration.duplicateGraph":
          return await this.copy(message.graphId)
        case "orchestration.renameGraph":
          return await this.rename(message.graphId, message.name)
        case "orchestration.publishAsAgent":
          return await this.publish(message.graphId)
        case "orchestration.startRun":
          return await this.start(message.graph, message.input)
        case "orchestration.getRun":
          return await this.get(message.runId)
        case "orchestration.cancelRun":
          return await this.cancel(message.runId)
        case "orchestration.resolveCheckpoint":
          return await this.checkpoint(message)
      }
    } catch (err) {
      const detail = err instanceof PublishError ? err.message : getErrorMessage(err)
      this.opts.post({ type: "orchestration.failed", operation: message.type, message: detail || "Operation failed" })
    }
  }

  private async graphs() {
    this.opts.post({ type: "orchestration.graphs", graphs: await listGraphs(await this.opts.configDir()) })
  }

  private async load(id: string) {
    const graph = await readGraph(await this.opts.configDir(), id)
    if (!graph) return this.fail("loadGraph", "Graph not found")
    this.opts.post({ type: "orchestration.graph", graph })
  }

  private async save(graph: OrchestrationGraph, persisted: boolean) {
    const dir = await this.opts.configDir()
    const result = await persistGraph(dir, graph, persisted)
    const renamed =
      result.previous !== null &&
      result.previous.name !== result.saved.name &&
      (await syncPublishedAgent(this.opts.client(), this.opts.directory(), result.saved))
    this.opts.post({ type: "orchestration.saved", graph: result.saved })
    await this.graphs()
    if (renamed) await this.opts.refreshAgents?.()
  }

  private async remove(id: string) {
    const removed = await unpublishGraph(this.opts.client(), this.opts.directory(), id)
    await deleteGraph(await this.opts.configDir(), id)
    this.opts.post({ type: "orchestration.deleted", graphId: id })
    await this.graphs()
    if (removed) await this.opts.refreshAgents?.()
  }

  private async copy(id: string) {
    const graph = await duplicateGraph(await this.opts.configDir(), id)
    if (!graph) return this.fail("duplicateGraph", "Graph not found")
    this.opts.post({ type: "orchestration.graph", graph })
    await this.graphs()
  }

  private async rename(id: string, name: string) {
    const graph = await renameGraph(await this.opts.configDir(), id, name.trim() || "Untitled")
    if (!graph) return this.fail("renameGraph", "Graph not found")
    const renamed = await syncPublishedAgent(this.opts.client(), this.opts.directory(), graph)
    this.opts.post({ type: "orchestration.saved", graph })
    await this.graphs()
    if (renamed) await this.opts.refreshAgents?.()
  }

  private async publish(id: string) {
    const graph = await readGraph(await this.opts.configDir(), id)
    if (!graph) return this.fail("publishAsAgent", "Graph not found")
    const issues = validateGraph(graph, await this.opts.agents())
    if (issues.length) return this.fail("publishAsAgent", issues.map((issue) => issue.message).join("; "))
    const result = buildAgentConfigFromGraph(graph)
    await this.opts
      .client()
      .config.overlayUpdate(
        { scope: "global", set: { agent: { [result.slug]: result.config } }, directory: this.opts.directory() },
        { throwOnError: true },
      )
    this.opts.post({ type: "orchestration.published", agentName: graph.name, slug: result.slug })
    await this.opts.refreshAgents?.()
  }

  private async start(graph: OrchestrationGraph, input: string) {
    const body = graph as unknown as NonNullable<OrchestrationStartData["body"]>["graph"]
    const { data } = await this.opts
      .client()
      .orchestration.start({ graph: body, input, directory: this.opts.directory() }, { throwOnError: true })
    this.runId = data.id
    this.opts.post({ type: "orchestration.run", run: data })
  }

  private async get(id: string) {
    const { data } = await this.opts
      .client()
      .orchestration.get({ runID: id, directory: this.opts.directory() }, { throwOnError: true })
    this.runId = data.id
    this.opts.post({ type: "orchestration.run", run: data })
  }

  private async cancel(id: string) {
    const { data } = await this.opts
      .client()
      .orchestration.cancel({ runID: id, directory: this.opts.directory() }, { throwOnError: true })
    this.opts.post({ type: "orchestration.run", run: data })
  }

  private async checkpoint(message: Extract<OrchestrationRequest, { type: "orchestration.resolveCheckpoint" }>) {
    const { data } = await this.opts.client().orchestration.checkpoint(
      {
        runID: message.runId,
        nodeId: message.nodeId,
        outcome: message.outcome,
        feedback: message.feedback,
        directory: this.opts.directory(),
      },
      { throwOnError: true },
    )
    this.opts.post({ type: "orchestration.run", run: data })
  }

  private fail(operation: string, message: string) {
    this.opts.post({ type: "orchestration.failed", operation, message })
  }
}
