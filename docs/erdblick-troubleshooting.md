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
- Use the style editor to catch YAML syntax errors before saving.

## Local Storage Reset

Some issues stem from stale cached data (styles, search history, view state):

1. Open the viewer in a private browser window to see if the problem is gone - if this is the case, proceed with the following steps.
2. Open the Preferences dialog and use the “Clear” button next to “Storage for Viewer properties and search history”.
3. Alternatively, clear the site data via your browser's developer tools.
4. Reload the page. All imported styles and stored preferences are wiped.

## When Reporting Issues

When you report a problem, including a few concrete details makes it much easier to reproduce and fix:

- Browser and OS version.
- Screenshot of the distribution version dialog which appears when cliking on the version in the top-right corner.
- Screenshot of the statistics overlay plus any visible errors.
- The URL that reproduces the issue for you.
- Relevant snippets of your backend configuration (for example the mapget configuration YAML that defines your sources) if the bug affects only specific maps or layers.
