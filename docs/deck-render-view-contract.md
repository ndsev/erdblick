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

### `app/mapview/deck/deck-view.ts`
- subscribes to map service topics for render/destroy/pick/move updates

## 3D navigation ownership

Feature-relative navigation is split into generic camera behavior and Erdblick representation policy:

- `app/mapview/deck/navigation/feature-navigation-map-controller.ts` owns gesture lifetime and locks one numeric world anchor for an interaction. It contains no feature, layer, tile, or Angular types.
- `app/mapview/deck/navigation/web-mercator-feature-navigation.ts` owns Web Mercator anchor projection and the local close-feature zoom constraint.
- `app/mapview/deck/navigation/erdblick-navigation-anchor.ts` owns deep picking, eligible-representation traversal, path snapping, point anchors, and coordinate conversion.
- `app/mapview/deck/deck-viewport-coverage.ts` owns the geographic footprint calculation used for tile coverage; it is intentionally separate from navigation math.
- `app/mapview/deck/deck-view.ts` owns feature identity, retained application targets, the navigation indicator, first-person switching, and controller wiring.

The controller and camera module exchange only `[longitude, latitude, altitude]` coordinates. Picking records and rendered layer objects must not become controller state because their lifetime is tied to tile and visualization updates.

## Not in first delivery parity scope
- OSM base map parity
- search marker parity
- zoom-to-rectangle animation parity
- right-click tile outline parity
