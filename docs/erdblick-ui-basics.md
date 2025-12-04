# UI Basics

Erdblick centers its UI around a single Cesium map canvas with docked utility panels. This section explains the controls that erdblick users rely on most often.

!!! note "Focus on the layout before advanced features"
    If you are new to the viewer, first get comfortable with the overall layout and basic navigation. The search, inspection, and SourceData features build directly on the concepts introduced in this guide.

![UI overview](erdblick_ui_overview.svg)

## Layout at a Glance

1. **Quick menu** – burger menu for settings, statistics and styles buttons. Clicking the menu button opens the "Maps and Layers" panel.
2. **Search bar** – focused with `Ctrl+K` and used for both jump actions and feature search.
3. **Maps & Layers panel** – lists data sources, their feature layers, and focus buttons that jump to the configured coverage area.
4. **Styles dialog** – opens from the toolbar and shows all bundled/imported style sheets.
5. **Inspector area** – collapsible column that can host up to three inspection panels.
6. **Status indicators** – tile and performance statistics plus a coordinate readout.

_[Screenshot placeholder: zoomed-in callouts for quick menu buttons and the burger menu.]_

## Navigating the Map

You can move around the map using a mix of mouse gestures, keyboard shortcuts, and on-screen controls:

- **Mouse**: left drag pans, middle-drag tilts, right drag zooms, scroll zooms.
- **Keyboard**: `WASD` pans, `Q/E` zoom, `Ctrl+K` focuses the search field, and `M` toggles the Maps & Layers panel.
- **Compass widget**: click to reset heading or drag to rotate.
- **Map focus buttons**: use the focus icons in the Maps & Layers panel to jump directly to the coverage area advertised for a map or layer instead of manually panning and zooming.

## Main Button Menu and Quick Actions

Hover over the floating stacks icon in the upper-left corner to reveal a quick menu. Each icon opens a core dialog without covering the map:

- **Help** – opens the documentation link configured for the build.
- **Preferences** – tile limits, dark mode, experimental settings, storage resets.
- **Controls** – keyboard shortcut reference.
- **Datasources** – opens the [DataSource editor](erdblick-datasource-editor.md) when the backend exposes the `/config` endpoint.
- **Styles** – edit and activate style sheets via the dedicated dialog.
- **Statistics** – an advanced dialogue to inspect performance characteristics for the current viewport.

Click the stacks icon (or press `M`) to open or hide the Maps & Layers dialog itself.

## Maps, Layers, and Base Content

Use the `Maps & Layers` panel to:

- Turn maps and their feature layers on or off.
- Use the **Focus Icon** to focus on a map or layer; clicking it zooms to the coverage area advertised by the backend.
- Adjust **per-layer Style Options** using the checkboxes rendered beneath each layer. These options come from the active style sheets and only affect the selected layer and view.
- Use the **Sync Layers** button (circular arrows next to each view tab) to clone the current visibility, zoom level, tile-border flag, and all per-layer style option values across every compatible layer. When layer synchronization is enabled in split view, those settings propagate to the opposite pane as well.
- Control the **Background Map** with the OSM overlay toggle and opacity slider shown per view.
- Inspect **Service Metadata** for each datasource: use the menu which appears when clicking the `{}`-Button which appears to the right of the map name.
- Enable **Tile Borders** by clicking the respective button when hovering over a map layer node.
- Change the **Tile Level** which is loaded for a particular layer, the controls appear when hovering over the layer node.

!!! note "Map Grouping is controlled by mapviewer.yaml"
    Slash-separated group names in the `mapId` can be used to nest related maps
    in the map layer tree. E.g. `NDS.Live/Europe` will put the `Europe` map and its
    layers under the `NDS.Live` parent group node. Note: Whole map groups can also
    be turned on or off using the checkbox in the tree.

Finally, at the bottom of the dialog, the `Add View` button may be used to open a [Split View](erdblick-split.md) for map comparison/side-by-side navigation.

_[Screenshot placeholder: Panel showing multiple maps toggled plus the focus (coverage) button highlighted.]_

## Coordinate panel and markers

- The compact panel in the status bar shows the current cursor position. While you move the mouse over the map, it streams WGS‑84 longitude/latitude plus pre-computed MapViewer tile IDs for levels 0–15. Click any label to copy that value.
- Use the dropdown to choose which systems to display. When an extension module provides extra conversions (for example NDS coordinates or custom tile IDs), those appear as additional toggleable entries.
- The left marker button toggles placement mode. When enabled, the next map click drops a single marker at that position, freezes the coordinate readout, and turns the button into a reset icon. A second button appears to focus the current view on the stored marker.
- Marker state is shared across views: enabling or resetting it updates both panes, and focusing uses the currently active view tab. Disabling the marker clears it from the scene and resumes live coordinate updates.

## Styles Dialog

Open the **Styles** dialog via the quick action menu:

- Activate or deactivate entire style sheets.
- Launch the style editor dialog to inspect or adjust YAML style definitions.
- Import/export styles to/from the browser's local storage.

See the [Style System Guide](erdblick-stylesystem.md) for deep dives on YAML structures and GUI workflows.

## Inspector Column

Selecting a feature opens its details in the inspection column:

- Hold `Ctrl` while clicking to spawn additional panels and pin them immediately (three panels by default; you can lift this limit in the Preferences dialog).
- Pin panels to keep their content while exploring the map; unpinned panels always show the most recent selection.
- Use the filtering input at the top of each panel to locate attributes quickly.
- Follow related feature links or open SourceData from the context menu.

Read the [Inspection Guide](erdblick-inspection.md) for feature-focused workflows.

## Search, Jump, and History

`Ctrl+K` (or clicking into the text field) focuses the search control. The panel combines:

- Jump-to actions (coordinates, tiles, feature identifiers, SourceData shortcuts).
- Feature search queries with Simfil expressions.
- Search history with inline remove buttons so you can re-run prior inputs or tidy the list.

The dedicated [Search Guide](erdblick-search.md) documents every action plus language tips.

## Preferences and Resets

Open the Preferences dialog from the quick menu:

- Adjust tile load/visualization limits and switch dark mode on, off, or automatic.
- Allow unlimited inspected features when you need more than three inspection panels.
- Clear stored viewer properties, search history, and style overrides if the UI behaves unexpectedly.

_[Screenshot placeholder: Preferences dialog showing tile limit sliders and reset buttons.]_
