# URL Guide

Erdblick encodes the full UI state inside the browser URL. That makes it easy to bookmark views, send links to colleagues, or preconfigure visualization-only deployments.

_[Screenshot placeholder: Browser address bar with a long erdblick URL highlighted.]_

## What Gets Stored in the URL?

- Camera state: latitude, longitude, altitude, and orientation (heading, pitch, roll).
- Active maps, layers, and per-layer settings.
- Enabled styles plus the values of all style options per map layer and view.
- Split-view state (second viewport and sync toggles).
- Search term/history pointer, if a query is active.

The URL is pruned automatically so it never grows beyond a few kilobytes, even after extended sessions.

## Visualization-Only Parameters

When running the visualization-only build or embedding erdblick without UI panels, use URL parameters to set the initial state:

| Parameter | Description |
| --- | --- |
| `lon`, `lat`, `alt` | Center position in degrees and altitude in meters. |
| `h`, `p`, `r` | Camera orientation (radians: heading, pitch, roll). |
| `osm` | Toggle the base map overlay (`true`/`false`), per view. |
| `osmOp` | Base map opacity in percent (0–100), per view. |
| `tll` | Maximum number of tiles to load, per view. |
| `tvl` | Maximum number of tiles to visualize, per view. |

Example:

```
http://localhost:8089/?lon=11.0454671&lat=48.0179306&alt=1000&h=0.5&p=-0.7&osm=true&osmOp=30&tll=1024&tvl=256
```

## Sharing Links

To share a particular map configuration with others, first get the view into the desired state and then capture the URL:

1. Configure the map exactly as needed (activate sources, zoom, tweak styles).
2. Click the link icon at the bottom of the search panel or copy the browser URL directly.
3. Send the link. Recipients load the same camera, layer, and style state.

Keep a few guidelines in mind when preparing URLs for long-term use:

- Capture the URL after tiles finish loading so that linked users do not need to interact before the state replays.
- If the link should remain valid for a long time, avoid referencing temporary maps or styles that live only in your local config.
- For official documentation, paste the copied URL into Markdown as a reference for screenshots or tutorials.

## Troubleshooting URL State

If a copied URL does not restore the expected state, a few common issues are worth checking first:

- If a link no longer opens correctly, verify that the map IDs and style IDs referenced in the URL still exist.
- Clear the browser history or use an incognito window if the URL appears correct but the UI keeps loading an older state. Cached `localStorage` overrides may conflict with the encoded state.
- If a URL looks correct but loads an unexpected state, use the Preferences dialog to clear stored viewer properties and search history, then reload the link.
