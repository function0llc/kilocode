// Editor-local types shared by Canvas, Inspector, Toolbar, and Editor.

export type Selection = { kind: "node" | "edge"; id: string }

export type PaletteDragItem = {
  kind: "agent" | "subagent" | "skill" | "mcp"
  name: string
}

export type PalettePointerDetail = {
  item: PaletteDragItem
  clientX: number
  clientY: number
}

export const PALETTE_MOVE = "orchestration-palette-move"
export const PALETTE_DROP = "orchestration-palette-drop"
export const PALETTE_END = "orchestration-palette-end"

let dragged: PaletteDragItem | null = null

export function setDrag(item: PaletteDragItem | null): void {
  dragged = item
}

export function getDrag(): PaletteDragItem | null {
  return dragged
}

export type CanvasApi = {
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  centerWorld: () => { x: number; y: number }
}
