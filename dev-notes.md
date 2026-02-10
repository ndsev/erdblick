# dev-notes

## Debugging 3D Tiles
- Use `ebDebug.renderTile(tileId, mapId, layerId, styleId, viewIndex?)` to force-fetch and render a tile. It loads the tile via the normal `/tiles` stream and immediately calls `TileVisualization.render`, returning a Promise once done.
- Use `window.__ERDBLICK_DEBUG_3DTILES_SHOW_CENTERLINE__ = true` to display centerline GL LINES for 3D tiles. This helps validate coordinates before tackling meshline width/shaders. The centerline primitives are always present but hidden unless this flag is set.
- Avoid `window.__ERDBLICK_DEBUG_3DTILES__` for routine checks. It parses glb bytes and is very slow for large tiles.

## Screenshots
- When taking screenshots via Chrome MCP, save them under `dev-screenshots/` so they are easy to review.

## Validation Steps
- Build: `./ci/20_linux_rebuild.bash debug`
- In the browser console (or via Chrome MCP):
  - 3D tiles centerline check:
    - `window.__ERDBLICK_DEBUG_3DTILES_SHOW_CENTERLINE__ = true;`
    - `await window.ebDebug.renderTile(37357750779917, "Island-6-Local", "Lane", "DefaultStyle", 0);`
    - Optional visibility boost: `window.ebDebug.getViewer(0).scene.globe.depthTestAgainstTerrain = false;`
  - Legacy check:
    - `window.ebDebug.stateService.visualizationBackend = "legacy";`
    - `window.ebDebug.mapService.clearAllTileVisualizations(0, window.ebDebug.getViewer(0));`
    - `await window.ebDebug.renderTile(37357750779917, "Island-6-Local", "Lane", "DefaultStyle", 0);`
  - Screenshot path: `dev-screenshots/`

## Findings
- The 3D tiles path is producing a valid tileset and GLB; centerline rendering validates coordinates before tackling meshline width/dash behavior.
