// Orchestration SolidJS entry point (editor tab webview bundle).

import { render } from "solid-js/web"
import "@kilocode/kilo-ui/styles"
import "./orchestration.css"
import { OrchestrationApp } from "./OrchestrationApp"

const root = document.getElementById("root")
if (root) {
  render(() => <OrchestrationApp />, root)
}
