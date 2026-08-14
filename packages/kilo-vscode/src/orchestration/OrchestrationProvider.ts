import * as os from "os"
import * as vscode from "vscode"
import { buildWebviewHtml } from "../utils"
import { getErrorMessage, filterVisibleAgents, indexProvidersById, mapAgent } from "../kilo-provider-utils"
import { retry } from "../services/cli-backend/retry"
import { type KiloConnectionService, ServerStartupError } from "../services/cli-backend"
import { computeDefaultSelection, fetchProviderData } from "../provider-actions"
import { validateGraph, type OrchestrationGraph } from "./domain"
import { deleteGraph, duplicateGraph, listGraphs, readGraph, renameGraph, uniqueId, writeGraph } from "./graph-storage"
import { buildAgentConfigFromGraph, PublishError, unpublishGraph } from "./publish"
import type { OrchestrationRequest } from "./messages"
import type { OrchestrationStartData } from "@kilocode/sdk/v2"

type InMessage =
  | OrchestrationRequest
  | { type: "webviewReady" }
  | { type: "retryConnection" }
  | { type: "requestAgents" }
  | { type: "requestSkills" }
  | { type: "requestMcpStatus" }
  | { type: "requestProviders" }

export class OrchestrationProvider implements vscode.Disposable {
  public static readonly viewType = "kilo-code.new.OrchestrationPanel"

  private panel: vscode.WebviewPanel | undefined
  private ready = false
  private configRoot: string | undefined
  private cachedAgents: unknown = null
  private cachedSkills: unknown = null
  private cachedMcp: unknown = null
  private cachedProviders: unknown = null
  private disposables: vscode.Disposable[] = []
  private subscriptions: Array<() => void> = []
  private runId: string | undefined

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connection: KiloConnectionService,
  ) {}

  openPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One)
      return
    }
    const panel = vscode.window.createWebviewPanel(
      OrchestrationProvider.viewType,
      "Kilo Orchestration",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    )
    this.attach(panel)
  }

  deserializePanel(panel: vscode.WebviewPanel): void {
    this.attach(panel)
  }

  dispose(): void {
    this.panel?.dispose()
    this.cleanup()
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.cleanup()
    this.panel = panel
    this.ready = false
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "assets", "icons", "kilo-light.svg"),
      dark: vscode.Uri.joinPath(this.extensionUri, "assets", "icons", "kilo-dark.svg"),
    }
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    }
    panel.webview.html = this.getHtml(panel.webview)

    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg) => void this.handle(msg as InMessage)),
      panel.onDidDispose(() => this.cleanup()),
    )
    this.subscriptions.push(
      this.connection.onStateChange((state, err) => {
        this.post({
          type: "connectionState",
          state,
          ...(err ? { error: err.message } : {}),
          ...(err instanceof ServerStartupError && {
            userMessage: err.userMessage,
            userDetails: err.userDetails,
          }),
        })
        if (state === "connected") void this.sync()
      }),
      this.connection.onEventFiltered(
        (event, directory) =>
          directory === this.directory() &&
          event.type === "orchestration.run.updated" &&
          (!this.runId || event.properties.runID === this.runId),
        (event) => {
          if (event.type !== "orchestration.run.updated") return
          this.runId = event.properties.runID
          this.post({
            type: "orchestration.runEvent",
            runId: event.properties.runID,
            revision: event.properties.revision,
          })
        },
      ),
    )
    void this.connect()
  }

  private cleanup(): void {
    for (const disposable of this.disposables) disposable.dispose()
    for (const unsubscribe of this.subscriptions) unsubscribe()
    this.disposables = []
    this.subscriptions = []
    this.panel = undefined
    this.ready = false
    this.configRoot = undefined
  }

  private directory(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir()
  }

  private async connect(): Promise<void> {
    try {
      await this.connection.connect(this.directory())
      await this.sync()
    } catch (err) {
      this.post({
        type: "connectionState",
        state: "error",
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof ServerStartupError && {
          userMessage: err.userMessage,
          userDetails: err.userDetails,
        }),
      })
    }
  }

  private async sync(): Promise<void> {
    if (!this.ready) return
    this.post({
      type: "orchestration.ready",
      vscodeLanguage: vscode.env.language,
      languageOverride: vscode.workspace.getConfiguration("kilo-code.new").get<string>("language"),
    })
    this.post({ type: "connectionState", state: this.connection.getConnectionState() })
    await Promise.all([
      this.fetchAndSendAgents(),
      this.fetchAndSendSkills(),
      this.fetchAndSendMcp(),
      this.fetchAndSendProviders(),
      this.sendGraphs(),
    ])
  }

  private async handle(msg: InMessage): Promise<void> {
    switch (msg.type) {
      case "webviewReady":
        this.ready = true
        if (this.connection.getConnectionState() === "connected") await this.sync()
        else await this.connect()
        return
      case "retryConnection":
        await this.connect()
        return
      case "requestAgents":
        await this.fetchAndSendAgents()
        return
      case "requestSkills":
        await this.fetchAndSendSkills()
        return
      case "requestMcpStatus":
        await this.fetchAndSendMcp()
        return
      case "requestProviders":
        await this.fetchAndSendProviders()
        return
      case "orchestration.listGraphs":
        await this.sendGraphs()
        return
      case "orchestration.loadGraph":
        await this.loadGraph(msg.graphId)
        return
      case "orchestration.saveGraph":
        await this.saveGraph(msg.graph)
        return
      case "orchestration.deleteGraph":
        await this.removeGraph(msg.graphId)
        return
      case "orchestration.duplicateGraph":
        await this.copyGraph(msg.graphId)
        return
      case "orchestration.renameGraph":
        await this.rename(msg.graphId, msg.name)
        return
      case "orchestration.publishAsAgent":
        await this.publish(msg.graphId)
        return
      case "orchestration.startRun":
        await this.startRun(msg.graph, msg.input)
        return
      case "orchestration.getRun":
        await this.getRun(msg.runId)
        return
      case "orchestration.cancelRun":
        await this.cancelRun(msg.runId)
        return
      case "orchestration.resolveCheckpoint":
        await this.checkpoint(msg)
        return
    }
  }

  /** Resolve (and cache) the CLI's global config directory via the backend. */
  private async configDir(): Promise<string> {
    if (this.configRoot) return this.configRoot
    const client = this.connection.getClient()
    const { data } = await client.path.get({ directory: this.directory() }, { throwOnError: true })
    this.configRoot = data.config
    return this.configRoot
  }

  private async sendGraphs(): Promise<void> {
    try {
      const dir = await this.configDir()
      this.post({ type: "orchestration.graphs", graphs: await listGraphs(dir) })
    } catch (err) {
      this.fail("listGraphs", err)
    }
  }

  private async loadGraph(id: string): Promise<void> {
    try {
      const graph = await readGraph(await this.configDir(), id)
      if (!graph) {
        this.post({ type: "orchestration.failed", operation: "loadGraph", message: "Graph not found" })
        return
      }
      this.post({ type: "orchestration.graph", graph })
    } catch (err) {
      this.fail("loadGraph", err)
    }
  }

  private async saveGraph(graph: OrchestrationGraph): Promise<void> {
    try {
      const dir = await this.configDir()
      // A brand-new graph's id is just its name slug; if a different graph
      // already owns that file, give the newcomer a unique id instead of
      // overwriting the existing one.
      const existing = graph.id ? await readGraph(dir, graph.id) : null
      const id = existing && existing.name === graph.name ? existing.id : await uniqueId(dir, graph.id || graph.name)
      const saved = await writeGraph(dir, { ...graph, id })
      this.post({ type: "orchestration.saved", graph: saved })
      await this.sendGraphs()
    } catch (err) {
      this.fail("saveGraph", err)
    }
  }

  private async removeGraph(id: string): Promise<void> {
    try {
      const removed = await unpublishGraph(this.connection.getClient(), this.directory(), id)
      await deleteGraph(await this.configDir(), id)
      this.post({ type: "orchestration.deleted", graphId: id })
      await this.sendGraphs()
      if (removed) {
        this.cachedAgents = null
        await this.fetchAndSendAgents()
      }
    } catch (err) {
      this.fail("deleteGraph", err)
    }
  }

  private async copyGraph(id: string): Promise<void> {
    try {
      const copy = await duplicateGraph(await this.configDir(), id)
      if (!copy) {
        this.post({ type: "orchestration.failed", operation: "duplicateGraph", message: "Graph not found" })
        return
      }
      this.post({ type: "orchestration.graph", graph: copy })
      await this.sendGraphs()
    } catch (err) {
      this.fail("duplicateGraph", err)
    }
  }

  private async rename(id: string, name: string): Promise<void> {
    try {
      const graph = await renameGraph(await this.configDir(), id, name.trim() || "Untitled")
      if (!graph) {
        this.post({ type: "orchestration.failed", operation: "renameGraph", message: "Graph not found" })
        return
      }
      this.post({ type: "orchestration.saved", graph })
      await this.sendGraphs()
    } catch (err) {
      this.fail("renameGraph", err)
    }
  }

  private async publish(id: string): Promise<void> {
    try {
      const dir = await this.configDir()
      const graph = await readGraph(dir, id)
      if (!graph) {
        this.post({ type: "orchestration.failed", operation: "publishAsAgent", message: "Graph not found" })
        return
      }
      const names = await this.agentNames()
      const issues = validateGraph(graph, names)
      if (issues.length > 0) {
        this.post({
          type: "orchestration.failed",
          operation: "publishAsAgent",
          message: issues.map((issue) => issue.message).join("; "),
        })
        return
      }
      const { slug, config } = buildAgentConfigFromGraph(graph)
      const client = this.connection.getClient()
      await client.config.overlayUpdate(
        { scope: "global", set: { agent: { [slug]: config } }, directory: this.directory() },
        { throwOnError: true },
      )
      this.post({ type: "orchestration.published", agentName: graph.name, slug })
      // Other webviews pick up the new agent via the global.config.updated SSE
      // event; refresh this panel's own palette cache too.
      this.cachedAgents = null
      await this.fetchAndSendAgents()
    } catch (err) {
      const message = err instanceof PublishError ? err.message : getErrorMessage(err)
      this.post({ type: "orchestration.failed", operation: "publishAsAgent", message: message || "Publish failed" })
    }
  }

  private async agentNames(): Promise<string[] | undefined> {
    try {
      const client = this.connection.getClient()
      const { data } = await retry(() => client.app.agents({ directory: this.directory() }, { throwOnError: true }))
      return data.map((agent) => agent.name)
    } catch (err) {
      console.warn("[Kilo New] Orchestration: agent roster fetch failed:", err)
      return undefined
    }
  }

  private async startRun(graph: OrchestrationGraph, input: string): Promise<void> {
    try {
      const client = this.connection.getClient()
      const { data } = await client.orchestration.start(
        {
          graph: graph as unknown as NonNullable<OrchestrationStartData["body"]>["graph"],
          input,
          directory: this.directory(),
        },
        { throwOnError: true },
      )
      this.runId = data.id
      this.post({ type: "orchestration.run", run: data })
    } catch (err) {
      this.fail("startRun", err)
    }
  }

  private async getRun(id: string): Promise<void> {
    try {
      const client = this.connection.getClient()
      const { data } = await client.orchestration.get(
        { runID: id, directory: this.directory() },
        { throwOnError: true },
      )
      this.runId = data.id
      this.post({ type: "orchestration.run", run: data })
    } catch (err) {
      this.fail("getRun", err)
    }
  }

  private async cancelRun(id: string): Promise<void> {
    try {
      const client = this.connection.getClient()
      const { data } = await client.orchestration.cancel(
        { runID: id, directory: this.directory() },
        { throwOnError: true },
      )
      this.post({ type: "orchestration.run", run: data })
    } catch (err) {
      this.fail("cancelRun", err)
    }
  }

  private async checkpoint(
    msg: Extract<OrchestrationRequest, { type: "orchestration.resolveCheckpoint" }>,
  ): Promise<void> {
    try {
      const client = this.connection.getClient()
      const { data } = await client.orchestration.checkpoint(
        {
          runID: msg.runId,
          nodeId: msg.nodeId,
          outcome: msg.outcome,
          feedback: msg.feedback,
          directory: this.directory(),
        },
        { throwOnError: true },
      )
      this.post({ type: "orchestration.run", run: data })
    } catch (err) {
      this.fail("resolveCheckpoint", err)
    }
  }

  private async fetchAndSendAgents(): Promise<void> {
    if (this.connection.getConnectionState() !== "connected") {
      if (this.cachedAgents) this.post(this.cachedAgents)
      return
    }
    try {
      const client = this.connection.getClient()
      const { data: agents } = await retry(() =>
        client.app.agents({ directory: this.directory() }, { throwOnError: true }),
      )
      const { visible, defaultAgent } = filterVisibleAgents(agents)
      const message = {
        type: "agentsLoaded",
        agents: visible.map(mapAgent),
        allAgents: agents.map(mapAgent),
        defaultAgent,
      }
      this.cachedAgents = message
      this.post(message)
    } catch (error) {
      console.error("[Kilo New] Orchestration: Failed to fetch agents:", error)
    }
  }

  private async fetchAndSendSkills(): Promise<void> {
    if (this.connection.getConnectionState() !== "connected") {
      if (this.cachedSkills) this.post(this.cachedSkills)
      return
    }
    try {
      const client = this.connection.getClient()
      const { data: skills } = await retry(() =>
        client.app.skills({ directory: this.directory() }, { throwOnError: true }),
      )
      const message = { type: "skillsLoaded", skills }
      this.cachedSkills = message
      this.post(message)
    } catch (error) {
      console.error("[Kilo New] Orchestration: Failed to fetch skills:", error)
    }
  }

  private async fetchAndSendMcp(): Promise<void> {
    if (this.connection.getConnectionState() !== "connected") {
      if (this.cachedMcp) this.post(this.cachedMcp)
      return
    }
    try {
      const client = this.connection.getClient()
      const { data } = await retry(() => client.mcp.status({ directory: this.directory() }))
      if (data) {
        const message = { type: "mcpStatusLoaded", status: data }
        this.cachedMcp = message
        this.post(message)
      }
    } catch (error) {
      console.error("[Kilo New] Orchestration: Failed to fetch MCP status:", error)
    }
  }

  private async fetchAndSendProviders(): Promise<void> {
    if (this.connection.getConnectionState() !== "connected") {
      if (this.cachedProviders) this.post(this.cachedProviders)
      return
    }
    try {
      const client = this.connection.getClient()
      const { response, authMethods, authStates } = await fetchProviderData(client, this.directory())
      const message = {
        type: "providersLoaded",
        providers: indexProvidersById(response.all),
        connected: response.connected,
        defaults: response.default,
        defaultSelection: computeDefaultSelection(null, "", ""),
        authMethods,
        authStates,
      }
      this.cachedProviders = message
      this.post(message)
    } catch (error) {
      console.error("[Kilo New] Orchestration: Failed to fetch providers:", error)
    }
  }

  private fail(operation: string, err: unknown): void {
    console.error(`[Kilo New] Orchestration ${operation} failed:`, err)
    this.post({ type: "orchestration.failed", operation, message: getErrorMessage(err) || "Operation failed" })
  }

  private post(msg: unknown): void {
    if (!this.panel || !this.ready) return
    void this.panel.webview.postMessage(msg).then(undefined, (err) => {
      console.warn("[Kilo New] Orchestration panel postMessage failed:", err)
    })
  }

  private getHtml(webview: vscode.Webview): string {
    return buildWebviewHtml(webview, {
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "orchestration.js")),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "orchestration.css")),
      iconsBaseUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "assets", "icons")),
      workerUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "shiki-worker.js")),
      title: "Kilo Orchestration",
      port: this.connection.getServerInfo()?.port,
    })
  }
}
