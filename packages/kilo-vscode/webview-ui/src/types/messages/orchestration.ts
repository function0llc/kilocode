/**
 * Orchestration editor messages (extension <-> webview).
 * Aliases the extension-side contracts so both bundles share one definition
 * and the message-contract tests can find named type declarations.
 * Palette data uses the existing requestAgents / requestSkills /
 * requestMcpStatus messages, so no new request types are introduced for it.
 */

import type {
  OrchestrationRequest as OrchestrationRequestContract,
  OrchestrationResponse as OrchestrationResponseContract,
} from "../../../../src/orchestration/messages"
import type { GraphSummary as GraphSummaryModel } from "../../../../src/orchestration/domain"

export type OrchestrationRequest = OrchestrationRequestContract
export type OrchestrationResponse = OrchestrationResponseContract
export type GraphSummary = GraphSummaryModel
export type OrchestrationRun = import("../../../../src/orchestration/messages").OrchestrationRun
