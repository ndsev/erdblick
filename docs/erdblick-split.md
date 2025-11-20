# Split-Screen Usage Guide

Erdblick can render multiple independent map views side-by-side. Each view runs its own Cesium instance, has its own camera state, and can synchronize with its neighbors through the built-in view-sync controls. This guide explains how to add/remove views, focus a specific pane, and make the synchronization options work for you.

![Split view UI](erdblick_ui_split.svg)

## Opening, Closing, and Focusing Views

To start working with multiple panes, create and focus views from the Maps & Layers dialog:

1. **Open the Maps & Layers dialog** (click the stacks button or press `M`).
2. Scroll to the bottom and click **Add View**. The dialog creates a second tab (“Maps Right View”) and erdblick opens another map canvas next to the first one.
3. The right view can be closed by clicking its `[✕]` icon in the Maps & Layers dialog.
4. Click inside a view to focus it. The active view shows a blue outline, and keyboard shortcuts (`WASD`, `Q/E`, `Ctrl+K`, `Ctrl+X`, etc.) apply only to that view.
5. Use `Ctrl+ArrowRight` / `Ctrl+ArrowLeft` to cycle focus across panes without touching the mouse. You can also shift focus by clicking the split view you want to control.

Once multiple views exist, the Maps & Layers dialog displays a collapsible fieldset per view (left/right, or additional entries if you create more). Each fieldset contains the full map tree plus per-layer style overrides, so you can configure sources independently per view.

## View Sync Controls

Every non-primary view shows a small toggle group in its top-left corner. These switches control how camera and layer state is shared between views:

- **Position (`pos`)** – keeps all cameras on the same destination and orientation. Moving the focused view moves the others to the same place.
- **Movement (`mov`)** – mirrors mouse/keyboard movement deltas in real time while preserving each view’s relative offset. When you enable this, erdblick automatically resolves conflicts with position sync.
- **Projection (`proj`)** – keeps all views in the same projection. Switching one view between 2D and 3D updates the others as well.
- **Layers (`lay`)** – synchronizes map and layer visibility, per-layer style option values, and OSM overlay settings across views.

The sync settings are encoded in the URL and persisted in `localStorage`, so reloaded sessions keep the same behavior. Hover a toggle to see a short description of what it controls.

## Per-View Layer Management

Each view maintains independent layer trees:

- **Tabs per view** – the Maps & Layers dialog renders one expandable section per view. The icon next to each header indicates whether the section controls the left or right pane.
- **Layer sync button** – the circular arrows button in each section copies visibility, zoom level, tile-border flags, and style-option states from that view to all compatible layers. It’s the quickest way to align both panes before you start changing styles.
- **Add/remove** – the **Add View** button creates another view; closing the map tab removes it. All camera and layer selections are serialized into the URL, so you can share a split-view link with colleagues.

## Typical Workflows

Once split view is active, a few recurring patterns make it easier to compare data or styles across panes:

- **Compare data sources** – activate `pos` and `lay`, then point both panes at the same bounding box. Load an NDS.Live map on the left and NDS.Classic or GeoJSON on the right.
- **Style A/B testing** – keep `pos` on but leave `lay` off. This keeps the camera synchronized while letting each pane render its own style combinations or per-layer options.
- **Investigations with frozen reference** – pin the right pane (no sync toggles) on a feature, then continue exploring on the left. The outline shows which pane receives keyboard navigation.
- **2D vs 3D** – enable `lay` and `pos`, disable `proj`. Switch only one pane to 2D (Maps dialog → Projection), leaving the other in 3D to compare interactions.

_[Screenshot placeholder: Two panes showing different styles, sync toggles highlighted.]_

## Tips and Troubleshooting

When split view does not behave as expected, or you are fine-tuning performance, keep a few practical tips in mind:

- **Statistics** – the stats dialog aggregates data from every view. If performance suffers, lower tile limits per view (Preferences dialog) or disable unused styles.
- **URL/state persistence** – split-view layout, focus, and view-sync toggles are stored in the URL/query params. Copy the browser URL to preserve the current split configuration.
- **Visualization-only mode** – the sync toolbar and Maps dialog are hidden in visualization-only builds (`environment.visualizationOnly`). Use URL parameters to preconfigure both panes instead.
- **Focus issues** – if a view stops reacting to keyboard input, click inside it or use `Ctrl+Arrow` to move focus. The blue border always indicates the target view.

With these controls dialed in, you can treat split view as a full comparison workstation: compare sources, styles, projections, or even separate experiments—all without juggling multiple browser windows.
