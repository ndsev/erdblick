# UI Basics

Erdblick centers its UI around a single Cesium map canvas with docked utility panels. This section explains the controls that erdblick users rely on most often.

![UI overview](erdblick_ui_overview.svg)

## Layout at a Glance

1. **Toolbar** – burger menu for panels, split view toggle, statistics and settings buttons.
2. **Search bar** – focused with `Ctrl+K` and used for both jump actions and feature search.
3. **Maps & Layers panel** – lists data sources, their feature layers, and focus buttons that jump to the configured coverage area.
4. **Styles dialog** – opens from the toolbar and shows all bundled/imported style sheets.
5. **Inspector area** – collapsible column that can host up to three inspection panels.
6. **Status indicators** – tile and performance statistics plus a coordinate readout.

_[Screenshot placeholder: zoomed-in callouts for toolbar buttons and the burger menu.]_

## Navigating the Map

You can move around the map using a mix of mouse gestures, keyboard shortcuts, and on-screen controls:

- **Mouse**: left drag pans, right drag tilts, scroll zooms.
- **Keyboard**: `WASD` pans, `Q/E` zoom, `Ctrl+K` focuses the search field, and `M` toggles the Maps & Layers panel.
- **Compass widget**: click to reset heading or drag to rotate.
- **Statistics button**: opens a dialog that aggregates per‑tile statistics such as tile size and parse time so that you can diagnose performance without leaving the UI.

## Main Button Menu and Quick Actions

Hover over the floating stacks icon in the upper-left corner to reveal a quick menu. Each icon opens a core dialog without covering the map:

- **Help** – opens the documentation link configured for the build.
- **Preferences** – tile limits, dark mode, experimental settings, storage resets.
- **Controls** – keyboard shortcut reference.
- **Statistics** – same as the toolbar button, but reachable from the hover menu.
- **Datasources** – opens the DataSource editor when the backend exposes the `/config` endpoint.
- **Styles** – jumps directly into the Styles dialog.

Click the stacks icon (or press `M`) to pin or hide the Maps & Layers dialog itself.

## Maps, Layers, and Base Content

Use the `Maps & Layers` panel to:

- Turn maps and their feature layers on or off.
- Use the target icon to focus on a map or layer; the viewport animates to the coverage area advertised by the backend.
- Inspect coverage hints (available tiles vs. current zoom) to understand why some areas look empty.
- Adjust **per-layer style options** using the checkboxes rendered beneath each layer. These options come from the active style sheets and only affect the selected layer and view—useful for A/B testing styles without touching other layers or the second split view.
- Use the **sync layers** button (circular arrows next to each view tab) to clone the current visibility, zoom level, tile-border flag, and all per-layer style option values across every compatible layer. When layer synchronization is enabled in split view, those settings propagate to the opposite pane as well.
- Control the background map with the OSM overlay toggle and opacity slider shown per view.

_[Screenshot placeholder: Panel showing multiple maps toggled plus the focus (coverage) button highlighted.]_

## Styles Dialog

Open the drawer via the burger menu → **Styles**:

- Activate or deactivate entire style sheets.
- Toggle per-style options (checkboxes defined in the YAML).
- Launch the style editor dialog to inspect or adjust definitions in place.
- Import/export styles to/from the browser's local storage.
- Pair these global controls with the per-layer toggles in the Maps & Layers panel when you need different options for the same style on different layers or views.

See the [Style System Guide](erdblick-stylesystem.md) for deep dives on YAML structures and GUI workflows.

## Inspector Column

Selecting a feature opens its details in the inspection column:

- Hold `Ctrl` while clicking to spawn additional panels and pin them immediately (three panels by default; you can lift this limit in the Preferences dialog).
- Pin panels to keep their content while exploring the map; unpinned panels always show the most recent selection.
- Use the filtering input at the top of each panel to locate attributes quickly.
- Follow related feature links or open SourceData from the context menu.

Read the [Inspection Guide](erdblick-inspection.md) for feature-focused workflows.

## Search, Jump, and History

`Ctrl+K` (or the magnifier icon) focuses the search control. The panel combines:

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
