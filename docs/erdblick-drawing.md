# Local drawings and measurement

Use **File → Drawing tools** to draw on the map, or **File → New GeoJSON** / **New coordinates** to create or import a file. Dropped files use the same import path. All results are browser-local GeoJSON datasources and use the normal styling system. Nothing is uploaded to mapget or MapViewer.

The Maps accordion groups datasources under **Local** and **Remote** by default. Its header button toggles grouping and remembers the choice (`state.groupLocalRemoteSources`). A local map has a **local** tag, a pencil button to open its GeoJSON Editor, and a trash button to delete the source and its saved browser data. Closing an Editor keeps its map. Style controls appear directly beneath the source; the internal Drawing layer row is hidden.

## Drawing toolbar

The compact drawing toolbar opens near the bottom of the map. Drag its dotted grip to move it; its position is remembered in this browser. With the grip focused, arrow keys move it and Shift increases the step. Controls wrap to fit narrow windows. Hover over a tool icon to see its name.

Measurement and drawing icons, the color swatch, **New drawing**, **Undo point**, and **Finish** / **Resume** share one strip. A small readout below shows the selected tool and current measurements. Click the swatch to open the color picker. The **Drawing options** (⋮) popover contains units, help for the selected tool, and **Clear drawing**. Escape dismisses either popup without finishing the active drawing.

| Tool | Interaction |
| --- | --- |
| Distance | Click successive positions. The readout includes the cursor segment; map labels show each segment and the total. |
| Area | Click at least three corners. The readout shows the ellipsoidal area and closed perimeter, including the cursor while active. |
| Angle | Click the first arm, the vertex, then the second arm. The third click finishes the interior angle measurement. |
| Pen | Press and drag to draw a freehand line. Release to finish. The stroke captures the pointer, so the map does not pan during drawing. |
| Point | Click to add Point features to the current document. |
| Polygon | Click at least three corners. The shape closes automatically; Finish or Escape ends input. |
| Ellipse | Click the center, then a diagonal corner of its bounding box to set the east/west and north/south radii. The second click finishes. |

After the first position, a semi-transparent line connects the last point to the cursor. Hold **Shift** to snap the next segment to a WGS84 compass bearing in 45° increments. Snapping preserves its distance; 0° and 360° both mean north. The committed endpoint matches the preview, including when Shift changes while the pointer is stationary.

**Backspace** or **Undo point** removes the last position, repeatedly down to empty. **Finish** or **Escape** stops input and removes the live cursor contribution. **Resume** continues an unfinished sequence. **Clear drawing** in the options popover empties the current document. **New drawing**, switching tools, or closing the toolbar retains the previous result as a local datasource; the next result has its own document. Text editors, inputs, and modal dialogs retain their own keyboard behavior. Closing the captured map view also retains the result.

The color picker updates the active result and is stored as GeoJSON `properties.color`. Units follow `state.measurementUnit` (`meters` or `miles`), and areas use m² or mi². A mile is exactly 1,609.344 meters. Distances and areas use the WGS84 ellipsoid; height and terrain do not affect them. Angles are the smaller angle between geodesic bearings at the middle point. Area uses the smaller, orientation-independent ellipsoidal area; intersecting rings have algebraic area. Ellipses are sampled in a local east/north frame using geodesic destinations and exported as ordinary polygons. Polygons enclosing a pole are outside this drawing workflow.

Measurements include Point features, sampled path geometry, and label features. Labels are drawn through DrawingLayer's Deck text pipeline, using the bundled Drawing style. Changing units updates labels in the current toolbar result, including after Finish. Starting a new result, switching tools, or closing the toolbar leaves the previous document's labels unchanged. Numeric widget state and active tool history are session-only; geometry, labels, and colors survive reloads. Opening an active result's Editor stops its tool before edits begin.

Use regular 2D or 3D map views for live pointer drawing. First-person navigation does not provide a live ground-plane cursor projection.

## GeoJSON Editor: Save and Export

The Editor provides a full-height CodeMirror source editor and the same bottom action layout as the Style Editor. There is no separate points table. Edit coordinates, descriptions, colors, and other properties directly in GeoJSON. **Center** moves the captured map view to the document bounds without changing its scale or orientation.

**Save** (also Ctrl/Cmd+S) validates the current source and commits its local-save baseline in browser storage. It does not download a file. **Export** downloads the current valid GeoJSON as a separate file and does not change the saved baseline. **Discard** restores the last locally saved or imported baseline and its geometry. Invalid source shows a diagnostic and leaves the last valid geometry on the map; Save and Export require a valid draft.

Files and edits are also saved automatically to this browser's localStorage, like imported styles. Autosave retains an unfinished or invalid draft separately from the accepted source, so reload does not lose work. Explicit Save establishes the version used by Discard and the Editor's unsaved-change indicator. Closing the toolbar or Editor does not remove the source.

Browser copies belong to the current site address and browser profile. Clearing site data removes them. Browser storage has a smaller quota than the supported import size: if it is full or unavailable, live work and the previous stored revision remain available and the viewer reports **Browser copy not updated**. Use **Retry browser save**, export valid GeoJSON, or copy an invalid draft elsewhere before leaving. Writes detect changes already stored by another tab, but this is a best-effort check rather than a cross-tab transaction. Edit a given drawing in one tab at a time.

Only the current GeoJSON storage format is supported. Malformed records and unsupported versions are reported and left intact while other documents continue loading. There is no legacy coordinate-record migration.

## Coordinate import

Use UTF-8 text, one entry per nonblank line:

```text
11.575 48.137 520 "Entrance"
11.576 48.138 "Height defaults to zero"
11.577 48.139 -25 Description with spaces
```

The first value is **longitude (X)**, then **latitude (Y)**, both in WGS84 degrees. Optional height is in **centimeters**. Separate fields with spaces or tabs; the remainder is the description. Quote descriptions using JSON string syntax when empty, numeric-leading, or containing escapes.

Import converts every entry to a GeoJSON Point with `properties.description`, preserving order and converting centimeter height to meter altitude. The filename becomes `.geojson`. Raw coordinate text and its formatting are not retained. Map-created points use zero height. Hovering an imported point displays its description even when ordinary hover labels are disabled.

## GeoJSON and styling

GeoJSON accepts FeatureCollection, Feature, and geometry roots, multi-geometries, polygon holes, nested GeometryCollections, null geometry, and null properties. Positions have two or three coordinates; altitude is in meters. Legacy CRS declarations are rejected. Source parsing preserves foreign members and large integer ID lexemes without rounding them through JavaScript numbers. User properties are inert data, including names such as `layer`, `typeId`, and `$mapgetRelation`.

The bundled **Drawing** style targets layer `Drawing`. Visibility, feature filters, colors, labels, and interaction effects use the regular styling system. Native drawing fields include `attributes.drawing.description`, `attributes.drawing.role`, and `attributes.drawing.ordinal`; GeoJSON properties appear under `attributes.user`. Generated properties include `color`, `preview`, and `label`. Generated roles include `measurement-point`, `measurement-path`, `measurement-area`, `measurement-label`, `draw-point`, `draw-path`, `draw-area`, `cursor`, and `cursor-segment`. Styles can override the default rendering without changing GeoJSON content.

## Implementation boundaries and limits

`DrawingSource` uses mapget models, schema filtering, and feature-restricted inspection snapshots inside erdblick's WASM build. Its local object partition has ID `0`; no server datasource/service target is enabled. Browser-owned subscriptions feed the subset renderer. The lightweight Deck DrawingLayer draws local contributions in the shared GPU scene with separate material ownership and common picking, masks, and text layout.

Tool geometry, WGS84 metrics, and snapping are implemented in `drawing-geometry.cpp` using GeographicLib C v2.2. Committed document work runs in a dedicated worker. The cursor preview has a separate small UI-WASM owner and a reserved render worker; updates coalesce so imports cannot queue ahead of the cursor. Preview paths have at most two input points and bounded sampling. Geodesic linework and polygons split at the antimeridian for standard GeoJSON coordinates.

`DrawingStorageService` stores one schema-version-2 `drawingDocumentData:<mapId>` record per document: filename, accepted GeoJSON, differing draft/baseline text, and local-save status. Models restore after WASM/catalog initialization. Text autosave is debounced and flushed when leaving or hiding the page. File handles are not used. Undo history, list-independent tool history, and per-view local visibility/options remain session-only.

Local IDs and document data are excluded from URLs and application snapshots. Server-wide search and relation traversal are unavailable for local drawings. Local misses and retired IDs never fall back to the server. Shared-parser dictionary offsets are filtered at WebSocket, HTTP, and incoming-inspection boundaries. Worker recovery rebuilds accepted text and preserves record identities and their allocation watermark.

Files are limited to 32 MiB, 100,000 features, 1,000,000 geometry vertices, and JSON depth 64. A tool accepts at most 10,000 positions. The live segment has at most 2,048 sampled segments; distant cursor positions at close zoom may look coarser without affecting numerical distance. The field-name dictionary has 16-bit IDs; string values use owned storage. Duplicate JSON members, invalid UTF-8, nonfinite/out-of-range positions, unsupported dimensions, and integer property values outside signed 64-bit range produce diagnostics. Positions beyond Web Mercator's latitude limit remain in the source but may not display. Vertex dragging, topology repair, and terrain-following measurement are outside this workflow.
