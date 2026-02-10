# dev-summary

## Scope
- Goal: investigate 3D Tiles rendering path for performance and styling, add a 3D Tiles experimental backend with custom shader support, and debug why geometry is not visible.
- User requirement: focus first on Cesium 3D Tiles, support meshline-like styling (zoom-independent widths, arrowheads), keep legacy rendering as a toggle, add debugging facilities, and validate with the heavy tile `37357750779917` on `Island-6-Local/Lane`.

## Key Issues Observed (from user logs)
- Tileset loads and reports valid asset/root/transform/boundingVolume, but nothing visible.
- `Expected options.typedArray to be typeof object` error when loading a debug Model from blob (early run).
- Later error: `DeveloperError: normal is not available in the vertex shader. Did you mean normalMC...` from CustomShader.
- With debug volumes enabled, bounding spheres appear; without, only tiny specks or nothing.
- Camera already at target location; flyTo unnecessary.
- Multiple `/tiles status: Expected a text message containing JSON` log lines (noise from tiles websocket).
- WebGL lazy texture initialization warnings.

## Debugging Approach
- Added debug flags and attempted to use `ebDebug` to inspect tileset/model state.
- Introduced Chrome DevTools MCP to inspect the live page, check tileset content, and capture screenshots.
- Added a direct tile render helper to avoid slow debug paths and repeated UI interactions.
- Added a centerline GL LINES primitive for fast coordinate validation.

## Major Code Changes
- Added dedicated 3D Tiles renderer in C++ with glTF output:
  - `libs/core/src/visualization_3dtiles.cpp`
  - `libs/core/include/erdblick/visualization_3dtiles.h`
- Split legacy renderer:
  - `libs/core/src/visualization_legacy.cpp`
  - `libs/core/src/visualization.cpp` removed
- Added Tileset meshline shader:
  - `app/mapview/tileset-shader.ts`
- Hooked 3D Tiles path into tile visualization:
  - `app/mapview/tile.visualization.model.ts`
- Added debug API method to force render a tile:
  - `app/app.debugapi.component.ts`
- Preferences toggle for visualization backend and related updates:
  - `app/auxiliaries/preferences.component.ts`
  - `app/shared/appstate.service.ts`
  - `app/mapdata/map.service.ts`
  - `app/mapview/view.ts`
  - `app/integrations/cesium.ts`
- Build system adjustments:
  - `libs/core/CMakeLists.txt`
  - `libs/core/src/bindings.cpp`
  - `cmake/cesium.cmake`

## Shader and Geometry Details
- `tileset-shader.ts` uses `CustomShader` with `UNLIT` and `TRANSLUCENT`:
  - Attributes: `POSITION`, `NORMAL`, `TEXCOORD_0`, `TEXCOORD_1`, `TEXCOORD_2`, `COLOR_0`, `COLOR_1`.
  - Width computed from `TEXCOORD_1.x` and `czm_metersPerPixel`, with optional `u_widthMode` (pixels vs meters) and `u_widthScale`.
  - Dash masking from `TEXCOORD_1.y` and `TEXCOORD_2.x`.
  - Arrowhead masking currently disabled pending base line rendering validation.
  - Added `u_debugShowCenterline` to show/hide centerline GL LINES.
- C++ glTF generation:
  - Lines expanded into triangles (meshline), using `NORMAL` to carry right vector and width.
  - `TEXCOORD_0` contains lineU and side.
  - `TEXCOORD_1` contains width and dash length.
  - `TEXCOORD_2` contains dash pattern and arrow mode.
  - `COLOR_0` and `COLOR_1` for solid/gap colors.
  - Added GL LINES “centerline” primitive with `arrowMode = -1` so shader can identify it.
  - Tileset root transform uses ENU->ECEF with `gltfUpAxis: "Z"`.

## Debug API Additions
- Added `ebDebug.renderTile(tileId, mapId, layerId, styleId, viewIndex?)`:
  - Ensures tile is loaded via `/tiles`.
  - Creates or reuses a `TileVisualization`.
  - Renders immediately via `TileVisualization.render`.
  - Returns the visualization after rendering.
- Added debug uniforms:
  - `__ERDBLICK_DEBUG_3DTILES_SHOW_CENTERLINE__` toggles line centerline visibility.

## Debug Notes (written to dev-notes.md)
- Build step: `./ci/20_linux_rebuild.bash debug`.
- 3D tiles centerline check:
  - `window.__ERDBLICK_DEBUG_3DTILES_SHOW_CENTERLINE__ = true;`
  - `await window.ebDebug.renderTile(37357750779917, "Island-6-Local", "Lane", "DefaultStyle", 0);`
  - Optional: `window.ebDebug.getViewer(0).scene.globe.depthTestAgainstTerrain = false;`
- Legacy check:
  - `window.ebDebug.stateService.visualizationBackend = "legacy";`
  - `window.ebDebug.mapService.clearAllTileVisualizations(0, window.ebDebug.getViewer(0));`
  - `await window.ebDebug.renderTile(37357750779917, "Island-6-Local", "Lane", "DefaultStyle", 0);`
- Screenshot folder standardized to `dev-screenshots/`.

## Chrome MCP Findings
- Tileset loads, has content, and model is ready.
- Bounding sphere and transform appear valid.
- When centerline was enabled and depth test disabled, faint rendering artifacts appeared.
- MCP tool calls sometimes timed out after reloads, requiring manual reloads and re-queries.

## Screenshots
- `dev-screenshots/3dtiles-centerline.png` and `dev-screenshots/3dtiles-centerline-depthtest-off.png` created during 3D tiles centerline debugging.
- User requested legacy visualization screenshot validation next, but MCP calls timed out before completion.

## Build/Test Runs
- `./ci/20_linux_rebuild.bash debug` executed multiple times successfully.
  - Warnings: `LEGATE_JS_FFI` deprecated, wasm-ld signature mismatch warnings.
  - Angular builds completed for development and visualization-only-dev.
  - No manual server start is required; the existing `localhost:8089` server instance serves the updated build.

## Outstanding Items
- Validate legacy rendering in the current pipeline and capture a screenshot in `dev-screenshots/` as requested.
- Confirm centerline visibility without disabling depth test (if possible) and compare against legacy.
- Continue diagnosing meshline width/offset in custom shader once centerline is confirmed reliable.
- Address intermittent MCP timeouts after page reloads.
