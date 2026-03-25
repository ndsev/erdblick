# Diagnostics and Status Guide

Erdblick exposes loading, rendering, backend, and logging state directly in the UI. Use these tools when you need to understand why tiles are slow, incomplete, empty, or inconsistent.

![diagnostics](screenshots/diagnostics.png)

## Status at a Glance

The top-right side of the main bar contains the diagnostics indicator:

- While tiles are still being fetched or rendered, it shows a spinner.
- If the tile pipeline is paused, the spinner stays visible but switches to the paused styling.
- Once the current workload is complete, the spinner turns into a status dot.
- If the backend connection is down, the idle dot switches to the disconnected state.
- If erdblick has seen tile errors or log entries with error level, an extra error badge appears next to the indicator.

Click the indicator to open the progress popover. It shows:

- loaded vs. expected tile counts
- tile error count
- backend connection state
- backend and rendering progress counters
- shortcuts to **Open Statistics**, **Open Log**, and **Export**

## Tile Loading Overlays

Erdblick draws tile-status overlays directly on the map, even when tile borders are disabled:

- **Empty**: translucent gray fill
- **Error**: translucent red fill

These overlays are the fastest way to distinguish "still loading", "loaded but empty", and "backend error".

## Performance Statistics

Open **Tools -> Performance Statistics** from the main bar, or use **Open Statistics** from the diagnostics popover.

The statistics dialog is the main place to inspect:

- tile counts and tile errors
- backend progress
- parse and render timings
- per-style rendering cost
- frame-time and FPS

Use it when:

- a map feels slow after enabling more layers or styles
- you want to compare low tile budgets vs. high tile budgets
- you need evidence for a rendering regression or backend bottleneck

Combine it with tile borders and the per-view grid toggle when you need to correlate slow areas with concrete tile IDs.

## Logs and Backend State

Open **Tools -> Logs** to inspect the diagnostics log.

The log collects:

- browser-side console output
- backend connected / disconnected events
- transport and rendering errors that erdblick surfaces into the diagnostics stream

Use the log when the map looks healthy at first glance but the indicator shows an error badge, or when a datasource intermittently disconnects and reconnects.

## Exporting Diagnostics

Open **Tools -> Export Diagnostics** to create a diagnostics bundle for bug reports or offline analysis.

The export can include:

- current progress snapshot
- performance data
- collected logs
- backend status data, when available

This is the best way to hand over a reproducible diagnostics snapshot without asking somebody to manually copy values out of several dialogs.

## Pausing the Tile Pipeline

Erdblick can pause and resume tile rendering and backend communication. Use this when you want to freeze the current scene, inspect what is already loaded, or stop further churn while you investigate a specific tile state.

When the pipeline is paused:

- the diagnostics indicator keeps showing the paused state
- existing tiles remain visible
- no new backend/render progress is expected until you resume

## Typical Debugging Workflow

For difficult rendering or datasource issues, a simple sequence usually works well:

1. Focus the affected map or layer from **Maps & Layers**.
2. Enable tile borders if you need exact tile IDs.
3. Open the diagnostics popover and then the statistics dialog.
4. If the indicator shows errors, open the log as well.
5. Export a diagnostics bundle before resetting state or changing styles.

For broader recovery steps, see the [Troubleshooting Guide](erdblick-troubleshooting.md).
