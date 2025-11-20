# Troubleshooting Guide

This guide collects the fixes and workarounds that previously lived in scattered README sections. Use it when the UI appears empty, runs slowly, or needs a hard reset.

_[Screenshot placeholder: Statistics dialog highlighting tile counters.]_

## Nothing Renders

When the map stays blank or appears to render nothing at all, work through these checks in order:

1. Confirm that the viewport covers an area with data. Use the focus buttons (target icon) for maps or layers, or enter coordinates in the search box.
   **Note:** Focus buttons are only available if your map exposes coverage information.
2. Ensure that the map layer you want to see is activated (checked).
3. Open the browser console (F12) to see possible HTTP errors or CORS issues.
4. Reload, since it could be that you were silently logged out.

## Performance Issues

If the UI feels sluggish or frame rates drop when you move the camera, a few simple changes often restore responsiveness:

- Limit active maps and layers to what you actually need.
- Lower `Max tiles to load/visualize` in the Preferences dialog.
- Use Chromium-based browsers for the best WebGL throughput. Firefox/Safari generally render fewer tiles per frame.
- Capture screenshots of the statistics dialog for bug reports so we can see tile statistics and budgets.

_[Screenshot placeholder: Preferences dialog showing tile limit sliders used for tuning.]_

## Styles Look Wrong

When only the styling looks off—colors, labels, or overlays—but the tiles themselves are present, focus on the style configuration before suspecting the data:

- Use the style editor’s **Reset** and **Import/Export** actions, or the “Clear” buttons for imported styles and modified built‑in styles in the Preferences dialog, to get back to a known state.
- If a new style does not appear, make sure the YAML file exists under `config/styles` and is referenced by `config/config.json`.
- Use the style editor to catch YAML syntax errors before saving.

## Local Storage Reset

Some issues stem from stale cached data (styles, search history, view state):

1. Open the Preferences dialog and use the “Clear” button next to “Storage for Viewer properties and search history”.
2. Alternatively, clear the site data via your browser's developer tools.
3. Reload the page. All imported styles and stored preferences are wiped.

## Chrome Debugging Plugin

To inspect DWARF or source maps locally, install the [Chrome debugging helper](https://developer.chrome.com/docs/devtools/) and load the files listed in `docs/chrome_debugging_files.png` / `docs/chrome_debugging_plugin.png`. These screenshots remind you which checkboxes to enable. Map the local filesystem path of `erdblick` into the workspace section so breakpoints resolve correctly.

_[Screenshot placeholder: Chrome workspace mapping dialog referencing the repo.]_

## When Reporting Issues

When you report a problem, including a few concrete details makes it much easier to reproduce and fix:

- Browser and OS version.
- Erdblick build version and, if applicable, the host product or container tag.
- Screenshot of the statistics overlay plus any visible errors.
- The URL (state) that reproduces the issue.
- Relevant snippets of your backend configuration (for example the mapget configuration YAML that defines your sources) if the bug affects only specific maps or layers.
