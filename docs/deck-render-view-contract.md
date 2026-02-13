# Deck Render View Contract (Task 3 freeze)

Purpose: freeze the renderer-agnostic contract from current call sites before introducing `IRenderView` / `ITileVisualization`.

## Required `IRenderView` API

### Lifecycle
- `setup(): Promise<void>`
- `destroy(): Promise<void>`
- `isAvailable(): boolean`
- `requestRender(): void`

### View state and camera
- `getSceneMode(): unknown`
- `setViewFromState(...): void`
- `getViewState(): unknown`
- `computeViewport(): unknown`
- `getCameraHeadingDegrees(): number`

### Interaction and picking
- `pickFeature(screenPos: {x: number; y: number}): unknown[]`
- `pickCartographic(screenPos: {x: number; y: number}): unknown`

### UI integration
- `getCanvasClientRect(): DOMRect`
- `onTick(cb: () => void): void`
- `offTick(cb: () => void): void`

### Navigation controls
- `moveUp(): void`
- `moveDown(): void`
- `moveLeft(): void`
- `moveRight(): void`
- `zoomIn(): void`
- `zoomOut(): void`
- `resetOrientation(): void`

### Streams / events
- `hoveredFeatureIds` stream with payload:
  - `featureIds: (TileFeatureId | null | string)[]`
  - `position: {x: number, y: number}`

### Scene bridge
- `getSceneHandle(): IRenderSceneHandle`

## Current call-site traceability

### `app/mapview/view.component.ts`
- uses projection/rebuild behavior from mode state
- uses `mapView.hoveredFeatureIds`
- uses canvas rect for popover anchoring

### `app/mapview/view.ui.component.ts`
- uses scene mode state for 2D/3D toggle button
- uses tick callback + camera heading for compass
- uses navigation methods for buttons

### `app/mapview/view.container.component.ts`
- binds keyboard shortcuts to navigation methods

### `app/mapview/cesium/cesium-map-view.ts`
- subscribes to map service topics for render/destroy/pick/move updates

## Not in first delivery parity scope
- OSM base map parity
- search marker parity
- zoom-to-rectangle animation parity
- right-click tile outline parity
