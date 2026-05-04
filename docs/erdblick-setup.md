# Erdblick Setup Guide

Erdblick is a self-contained web application that talks to any mapget-compatible backend. This guide explains how to build the UI bundles, serve them with `mapget`, and adjust the configuration files that ship with the bundle.

_[Screenshot placeholder: Landing screen with the main menu closed to highlight the empty state.]_

## Build modes

| Mode | When to use it | How to build/select |
| --- | --- | --- |
| **Full** | Standard interactive UI with panels for maps, styles, inspection, search, statistics, and diagnostics. | From the erdblick repository root: `./build-ui.bash .` |
| **Visualization only** | Kiosk or embed scenarios where you control the view through URLs and hide editors/search panels. | From the erdblick repository root: `./build-ui.bash . visualization-only` |

Both variants connect to the same backend. Map data, sources, and layers are advertised by that backend (typically `mapget serve` running with your YAML config). The visualization-only build simply omits most UI panels; all state must be encoded in the startup URL or provided through the backend configuration.

Some container images or products ship a prebuilt erdblick bundle in a directory such as `/app/erdblick`. In those cases you usually do not need to run the build script yourself; consult the hosting product’s documentation for details.

## Quick start with releases

1. Download a release archive from the [erdblick releases](https://github.com/ndsev/erdblick/releases) page and unpack it into a directory, for example `~/Downloads/erdblick-dist`.
2. Install `mapget` from PyPI if you do not already have a backend: `pip install mapget`.
3. Serve the extracted bundle through mapget:
   ```bash
   mapget serve -w ~/Downloads/erdblick-dist
   ```
4. Open the printed URL in your browser. The UI loads `config.json` from the bundle for style declarations and extension modules, then connects to the backend via the `/sources` and `/tiles` endpoints to discover data.

_[Screenshot placeholder: Browser showing `mapget serve` output plus the initial erdblick home view.]_

## Running from source

1. Install Node.js LTS and PNPM (or npm) according to the requirements in `package.json`.
2. From the erdblick repository root, run `./build-ui.bash .` for an optimized production bundle. Set `NG_DEVELOP=true` before running the script if you need source maps and more verbose stack traces. Advanced setups can also use `./ci/20_linux_rebuild.bash` as part of a larger build pipeline.
3. Serve the build output directory with `mapget serve -w <path-to-dist>` or run a development server with:
   ```bash
   npm install
   npm start
   ```
   The development server is convenient for short interactive frontend sessions with test data.

## Backend configuration

Erdblick obtains its list of maps, layers, and styles from the backend through the standard mapget APIs:

- `/sources` exposes every configured map and its layers.
- `/tiles` streams tile payloads.
- `/config` provides the optional schema/model JSON used by the DataSource editor and may also contain an `erdblick` public section with server-supplied UI defaults.

Configure those data sources in the backend you run. For example, if you use the PyPI mapget package, run `mapget serve --config backend.yaml` and define your sources under the `sources:` key:

```yaml
sources:
  - type: DataSourceProcess
    cmd: cpp-sample-http-datasource
  - type: DataSourceHost
    url: https://api.example.com/tiles
```

Whenever the YAML file changes, mapget applies the new sources immediately; erdblick will pick them up as soon as `/sources` reflects the update. If your backend exposes a writable `/config` endpoint, you can adjust data sources from inside erdblick via the DataSource editor—see the dedicated guide for that workflow.

At startup erdblick loads bundled `config.json` first, then tries to read `/config` best-effort. If the response is HTTP `200`, does not report `datasourceConfigUnavailable: true`, and contains an object at `erdblick`, non-empty values from that object override or extend the bundled config. If `/config` is missing, unreachable, or unavailable, erdblick continues with `config.json`.

The server `erdblick` object uses the same keys as `config.json`: `styles`, `extensionModules`, `surveys`, `backgroundLayers`, `defaultBackgroundLayerId`, and optional `state`. Empty arrays, empty objects, empty strings, and `null` values are treated as absent and do not clear bundled config.

The `state` key uses the same snapshot shape exported by Advanced Preferences, not URL query parameter names. It seeds the viewer before local browser storage and URL parameters are applied.

## Customizing `config/`

The `config/` directory in the erdblick source tree controls UI-side metadata:

- `config/config.json` lists built-in style bundles and optional extension modules. Common keys:
  - `styles`: array of `{ "id": "...", "url": "<file>.yaml" }`; plain filenames are requested from `bundle/styles/`.
  - `extensionModules.distribVersions`: JavaScript file to display version provenance in the footer.
  - `extensionModules.jumpTargets`: JavaScript file that supplies additional jump-to shortcuts.
  - `surveys`: optional array configuring the in-app survey banner (`id`, `link`, `linkHtml`, optional `start`/`end` dates, `emoji`, and `background`); omit or leave empty to disable surveys.
  - `backgroundLayers`: optional array of raster backgrounds shown in the Maps panel. Supported types are:
    - `xyz`: tiled raster sources with `urlTemplate`, `minZoom`, `maxZoom`, `tileSize`, optional `extent`, and `defaultOpacity`.
    - `wms`: deck.gl `WMSLayer` sources with `url`, `layers`, optional `version`, `crs`, `format`, `transparent`, `vendorParameters`, and `defaultOpacity`.
  - `defaultBackgroundLayerId`: optional id of the background enabled by default for new views.
- `config/styles/*.yaml`: style sheets that appear in the Styles dialog.
- `config/*.js`: optional modules referenced from `config.json`.
- `images/backgrounds/*`: optional bundled XYZ raster tiles. The default config ships a coarse Blue Marble overview under `bundle/images/backgrounds/world-overview/...`. The `world-overview` path is kept stable for compatibility even though the user-facing layer name is now `Blue Marble`.

The bundled overview layer is documented in `docs/erdblick-backgrounds.md`.

Edit these files before running `build-ui.bash`, or replace them on disk after building by overlaying the `config/` directory in your deployment. For example, a Docker image might be started with:

```bash
docker run --rm -it -p 8089:8089 --name erdblick \
  -v $HOME/custom-config.json:/srv/erdblick/config/config.json:ro \
  -v $HOME/custom-styles:/srv/erdblick/config/styles:ro \
  erdblick:latest
```

Adapt the target paths (`/srv/erdblick/...`) to match the layout used by your own packaging.

If the hosting backend supplies `/config.erdblick`, prefer that for deployment-specific defaults that should vary by backend instance. Keep `config/config.json` for bundle defaults that should travel with the erdblick build itself. Server-supplied paths use the same route assumptions as `config.json`; erdblick does not create new static routes for styles, modules, or background assets.

## Serving styles and resources

Style entries that do not start with `http` or `bundle` are resolved under `bundle/styles/`. Keep shared YAML definitions in a directory under source control, copy them into the bundle during build time, and expose the same directory through your deployment pipeline. Imported styles (via the browser UI) always live in each user’s `localStorage`; clearing site data or using the reset actions in the Preferences and Styles dialogs removes them.

Background-layer URLs follow normal browser semantics. Relative and root-relative paths such as `bundle/images/backgrounds/world-overview/{z}/{x}/{y}.jpg` or `/imagery/ortho/{z}/{x}/{y}.jpg` work immediately when your web server exposes those paths. Raw server filesystem paths are not supported in `config.json`; publish them through static aliases or reverse-proxy routes instead.

WMS backgrounds are currently marked experimental in the UI because they rely on deck.gl’s experimental `WMSLayer`. They are intended for 2D use first and may not behave correctly in pitched 3D views.

_[Screenshot placeholder: Styles dialog showing built-in entries and one custom style loaded from config/styles.]_

## Browser and platform notes

A few practical browser and platform choices can make erdblick feel noticeably smoother and more reliable:

- Chromium-based browsers usually offer the highest WebGL throughput. Firefox and Safari work but may require higher tile limits to reach the same detail levels.
- Enable GPU acceleration in the browser to keep deck.gl responsive.
- Always serve the bundle through HTTP. Opening `index.html` directly from the filesystem fails because the UI fetches `config.json` via XHR.
- In air-gapped deployments, host erdblick and the mapget backend on the same LAN and point `config.json` to internal URLs for extension modules so the UI avoids external lookups.
