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
- `/config` provides the optional schema/model JSON used by the DataSource editor.

Configure those data sources in the backend you run. For example, if you use the PyPI mapget package, run `mapget serve --config backend.yaml` and define your sources under the `sources:` key:

```yaml
sources:
  - type: DataSourceProcess
    cmd: cpp-sample-http-datasource
  - type: DataSourceHost
    url: https://api.example.com/tiles
```

Whenever the YAML file changes, mapget applies the new sources immediately; erdblick will pick them up as soon as `/sources` reflects the update. If your backend exposes a writable `/config` endpoint, you can adjust data sources from inside erdblick via the DataSource editor—see the dedicated guide for that workflow.

## Customizing `config/`

The `config/` directory in the erdblick source tree controls UI-side metadata:

- `config/config.json` lists built-in style bundles and optional extension modules. Common keys:
  - `styles`: array of `{ "id": "...", "url": "styles/<file>.yaml" }`.
  - `extensionModules.distribVersions`: JavaScript file to display version provenance in the footer.
  - `extensionModules.jumpTargets`: JavaScript file that supplies additional jump-to shortcuts.
  - `surveys`: optional array configuring the in-app survey banner (`id`, `link`, `linkHtml`, optional `start`/`end` dates, `emoji`, and `background`); omit or leave empty to disable surveys.
- `config/styles/*.yaml`: style sheets that appear in the Styles dialog.
- `config/*.js`: optional modules referenced from `config.json`.

Edit these files before running `build-ui.bash`, or replace them on disk after building by overlaying the `config/` directory in your deployment. For example, a Docker image might be started with:

```bash
docker run --rm -it -p 8089:8089 --name erdblick \
  -v $HOME/custom-config.json:/srv/erdblick/config/config.json:ro \
  -v $HOME/custom-styles:/srv/erdblick/config/styles:ro \
  erdblick:latest
```

Adapt the target paths (`/srv/erdblick/...`) to match the layout used by your own packaging.

## Serving styles and resources

Styles are resolved relative to `config/styles`. Keep shared YAML definitions in a directory under source control, copy them into the bundle during build time, and expose the same directory through your deployment pipeline. Imported styles (via the browser UI) always live in each user’s `localStorage`; clearing site data or using the reset actions in the Preferences and Styles dialogs removes them.

_[Screenshot placeholder: Styles dialog showing built-in entries and one custom style loaded from config/styles.]_

## Browser and platform notes

A few practical browser and platform choices can make erdblick feel noticeably smoother and more reliable:

- Chromium-based browsers usually offer the highest WebGL throughput. Firefox and Safari work but may require higher tile limits to reach the same detail levels.
- Enable GPU acceleration in the browser to keep Cesium responsive.
- Always serve the bundle through HTTP. Opening `index.html` directly from the filesystem fails because the UI fetches `config.json` via XHR.
- In air-gapped deployments, host erdblick and the mapget backend on the same LAN and point `config.json` to internal URLs for extension modules so the UI avoids external lookups.
