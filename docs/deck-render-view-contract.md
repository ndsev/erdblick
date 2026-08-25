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

During an active split-view gesture, `DeckMapView` coalesces the newest camera
pose to one preview per animation frame. `MapViewStateService` applies the
selected position or movement synchronization policy and routes that preview
directly to sibling Deck renderers. Preview consumers update only their
controlled Deck camera; the settled gesture then commits one canonical
`AppStateService` update that owns tile coverage, storage, URL state, and
Angular-facing state notifications.

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

- deck.gl's canonical `MapController` owns gesture lifetime, true pointer/touch gesture origins, numeric target state, operation-specific camera invariants, and target-aware transitions behind its experimental `_targetNavigation` option. Pan translates the common-space viewport centre only in Web Mercator X/Y; rotate/zoom use the separate radius-aware orbit transform.
- `app/mapview/deck/navigation/erdblick-target-navigation-adapter.ts` maps Erdblick's rich feature target into deck.gl's numeric `MapInteractionTarget` and maps public `interactionTargetPosition` changes back into the product indicator lifecycle.
- `app/mapview/deck/navigation/web-mercator-feature-navigation.ts` owns Erdblick's scalar maximal-safe close-feature zoom policy, settled ground-centre conversion, and shared map-projection contract. `ErdblickMapView` and direct viewport consumers use the same custom `WebMercatorViewport`: the ordinary far-plane margin is supplemented by a physical -100 m altitude floor for close below-sea-level geometry, while Erdblick's longer bounded horizon cap prevents grazing views from being cut off by math.gl's short default cap. Active camera reconstruction is delegated to deck.gl's public `WebMercatorViewport` planar-pan and orbit/zoom operations.
- `app/mapview/deck/navigation/erdblick-navigation-anchor.ts` owns deep picking, eligible-representation traversal, path snapping, point anchors, and coordinate conversion.
- `app/mapview/deck/deck-viewport-coverage.ts` owns the geographic footprint calculation used for tile coverage. It consumes the shared projection viewport so every renderable ground point is requestable, while keeping geographic normalization and padding separate from navigation math.
- `app/mapview/deck/deck-view.ts` owns one provider-time filtered physical pick, feature identity, retained pointerless-command policy, the navigation indicator, first-person switching, and controller wiring. It does not cache a DOM pointer/touch target for controller acquisition.
- `CameraViewState.position` may be nonzero in active target-relative Deck state and is accepted for backward-compatible exact input. When interaction settles, Erdblick re-expresses the equivalent camera with a ground-centred `[0, 0, 0]` offset for TileLayer LOD, persistence, and view synchronization; longitude/latitude/zoom may change while the projected camera pose remains equivalent. Orthographic views use zero explicitly.

Erdblick passes deck.gl only `[longitude, latitude, altitude]` and view-local screen coordinates. Deck reconstructs pointer/touch gesture origins and owns view-to-canvas offsets; the provider uses the supplied viewport for one synchronous filtered pick and returns the target's honest projected view-local pixel. Feature IDs, picking records, surface normals, and rendered layer objects remain application state because their lifetime is tied to tile and visualization updates.

## Not in first delivery parity scope
- OSM base map parity
- search marker parity
- zoom-to-rectangle animation parity
- right-click tile outline parity
