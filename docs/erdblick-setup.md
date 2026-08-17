# Erdblick Setup Guide

Erdblick is a self-contained web application that talks to any mapget-compatible backend. This guide explains how to build the UI bundles, serve them with `mapget`, and adjust the configuration files that ship with the bundle.

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
4. Open the printed URL in your browser. The UI loads `/static-config/config.json` for style declarations and extension modules, then connects to the backend via the mapget catalog and interactive tile endpoints to discover data.

## Running from source

1. Install Node.js LTS and PNPM (or npm) according to the requirements in `package.json`.
2. From the erdblick repository root, run `./build-ui.bash .` for an optimized production bundle. Set `NG_DEVELOP=true` before running the script if you need a development build. Advanced setups can also use `./ci/20_linux_rebuild.bash`: its default profiling build keeps the release WASM and production Angular optimizer, but preserves JavaScript identifiers and source maps. Pass `production` for the compact deployment build.
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

At startup erdblick loads `/static-config/config.json` first, then tries to read `/config` best-effort. If the response is HTTP `200` and contains an object at `erdblick`, non-empty values from that object override or extend the static config even when the datasource model is unavailable. If `/config` is missing, unreachable, or does not contain a valid `erdblick` object, erdblick continues with `/static-config/config.json`.

The server `erdblick` object uses the same keys as `config.json`: `styles`, `mapPresets`, `extensionModules`, `surveys`, `backgroundLayers`, `defaultBackgroundLayerId`, `coordinates-enabled`, `coordinates-legal-terms`, and optional `state`. Empty arrays, empty objects, and empty strings are normally treated as absent. `mapPresets` is the deliberate exception: a present server list replaces the bundled list, and `mapPresets: []` explicitly clears it.

The `state` key uses the same snapshot shape exported by Advanced Preferences, not URL query parameter names. It seeds the viewer before local browser storage and URL parameters are applied.

## Customizing `config/`

The `config/` directory used to build or host erdblick controls UI-side metadata:

- `config/config.json` lists built-in style bundles and optional extension modules. Common keys:
  - `styles`: array of `{ "id": "...", "url": "<file>.yaml" }`; plain filenames are requested from `/static-config/styles/` and this list defines the base style set.
  - `additionalStyles`: optional array of extra style entries appended after the base style set. Entries use the same string or `{ "id": "...", "url": "..." }` shape as `styles`, but are tagged as additional in the UI.
  - `mapPresets`: optional inline array of map-agnostic compositions. Each entry has `id`, `name`, optional `enabled`, and a non-empty `layerPresets` list whose entries identify an exact `layerId`, owning `styleId`, and embedded `presetId`. There is no external preset file or URL.
  - `extensionModules.distribVersions`: JavaScript file to display version provenance in the footer.
  - `extensionModules.jumpTargets`: JavaScript file that supplies additional jump-to shortcuts.
  - `surveys`: optional array configuring the in-app survey banner (`id`, `link`, `linkHtml`, optional `start`/`end` dates, `emoji`, and `background`); omit or leave empty to disable surveys.
  - `backgroundLayers`: optional array of raster backgrounds shown in the Maps panel. Supported types are:
    - `xyz`: tiled raster sources with `urlTemplate`, `minZoom`, `maxZoom`, `tileSize`, optional `extent`, optional HTTP `headers`, and `defaultOpacity`. If `maxZoom` is omitted, erdblick now allows XYZ sources up to level 22; cap public providers explicitly when they stop earlier.
    - `wms`: deck.gl `WMSLayer` sources with `url`, `layers`, optional `version`, `crs`, `format`, `transparent`, optional HTTP `headers`, optional `vendorParameters`, and `defaultOpacity`.
  - `defaultBackgroundLayerId`: optional id of the background enabled by default for new views.
  - `coordinates-enabled`: optional boolean default for the browser-local **Show coordinates** preference. The bundled default is `true`.
  - `coordinates-legal-terms`: optional browser-reachable JSON, YAML, or YML document containing a non-empty `legal-terms` string. Supplying it forces the initial coordinate display off until the user accepts the terms.
- `config/styles/*.yaml`: style sheets that appear in the Styles dialog.
- `config/*.js`: optional modules referenced from `config.json`.
- `images/backgrounds/*`: optional bundled XYZ raster tiles. The default config includes OpenStreetMap as the active background, an online Esri World Imagery entry for higher zoom satellite imagery, and a coarse bundled Blue Marble overview under `bundle/images/backgrounds/world-overview/...` for offline fallback. The `world-overview` path is kept stable for compatibility even though the user-facing layer name is now `Blue Marble`.

The effective `mapPresets` list is configuration-owned and is not AppState or browser storage. Key omission disables the map-level catalog and management tab; an explicit `[]` enables an empty catalog. A present server list replaces the static list, while server omission inherits static configuration. Valid survivors from malformed server input remain usable, but editing is disabled until the YAML is repaired.

Native MapViewer deployments may advertise a narrow, revision-guarded map-preset write capability when `allow-post-config` is enabled and the server YAML contains a valid `erdblick.mapPresets` list. Add, availability toggles, and raw Apply then replace only that complete YAML list using `If-Match`; conflicts refetch the authoritative catalog. Static-only deployments and Python-launched Docker sessions are read-only because the latter mounts a disposable transformed YAML copy. Per-view selected map/layer presets remain ordinary browser state.

The bundled overview layer is documented in `docs/erdblick-backgrounds.md`.

Standalone Angular builds copy these assets below `/static-config`. MapViewer instead publishes its own flat `config/` directory at that route, so style and extension-module files are not compiled into the frontend JavaScript.

Packaged deployments can replace the runtime `static-config/` directory beside the `mapviewer` executable. For example, a Docker image can mount replacements at the corresponding packaged paths:

```bash
docker run --rm -it -p 8089:8089 --name erdblick \
  -v $HOME/custom-config.json:/srv/mapviewer/static-config/config.json:ro \
  -v $HOME/custom-styles:/srv/mapviewer/static-config/styles:ro \
  erdblick:latest
```

Adapt the target paths to match the layout used by your own packaging.

If the hosting backend supplies `/config.erdblick`, prefer that for deployment-specific defaults that should vary by backend instance. Keep `config/config.json` for defaults that should travel with the erdblick deployment. Server-supplied paths use the same route assumptions as `config.json`; erdblick does not create new static routes for styles, modules, background assets, or legal-term documents by itself.

### MapViewer source-style editing

When a locally built `mapviewer` can still access the `config/` directory from which it was compiled, it serves that directory directly at `/static-config`. The server advertises this development mode in the `erdblickRuntime` field of `/config`, mounts `/static-config/styles` as writable, and prints a prominent startup warning. The erdblick frontend shows the same persistent warning and adds **Save to Source** to the style editor. That action overwrites the existing YAML file in `config/styles/`; it does not create arbitrary files or make other static-config assets writable.

The generated `config/config.json` remains a normal build artifact. Re-run CMake when `config.json.in` substitutions change. Editing or saving an existing YAML style requires neither a CMake step nor an Angular rebuild; reload or resynchronize the style in erdblick to read an external edit.

If the source directory is unavailable, MapViewer falls back to the filtered `static-config/` copy beside the executable. That mode is read-only and does not expose the source-save action.

## Serving styles and resources

Style entries that do not start with `http`, `bundle`, or `/` are resolved under `/static-config/styles/`. Root-relative paths are requested as written and must be exposed by the hosting backend. Imported styles (via the browser UI) always live in each user’s `localStorage`; clearing site data or using the reset actions in the Preferences and Styles dialogs removes them.

Backends may also provide an `additionalStyles` list in `/config.erdblick` to append deployment-specific style sheets after the base style list. Additional style URLs are loaded exactly like other browser resources: every URL must already be reachable through the web server. Erdblick itself does not expand wildcards, scan directories, mount host paths, or resolve relative filesystem paths against a backend YAML file. If a host application such as MapViewer accepts relative or absolute filesystem paths in its own YAML config, that application resolves them and publishes browser-reachable URLs before erdblick reads `/config.erdblick`.

Coordinate legal terms follow the same browser-resource rule. Configure `coordinates-legal-terms` with a URL whose response is either `{"legal-terms": "legal text"}` or equivalent YAML. Erdblick renders the value as plain text. If the document is missing, unreadable, or does not contain the required string, coordinate display remains disabled. Hosting products such as MapViewer may mount a local document and rewrite the configured filesystem path to a public URL.

Layer presets travel with their owning style sheet; there is no separately served preset document. Map presets are inline `mapPresets` configuration data and likewise are never resolved as browser-resource URLs. See `docs/erdblick-stylesystem.md` for the embedded layer-preset syntax and the configuration section above for map-level compositions.

Additional styles are loaded after base styles. If an additional style has the same YAML `name:` as a base style, the additional style is active and the Styles dialog marks it with an **Additional** tag. A locally modified additional style takes precedence over its original additional style, which takes precedence over the base style. For colliding base/additional styles, the **Additional** tag opens a read-only comparison against the base style.

Packaging-specific conveniences, such as MapViewer's `/custom-styles` mounts, native-host local path resolution, runtime static mount registration, and directory wildcard expansion, are implemented by the hosting application before erdblick sees the config.

Background-layer URLs follow normal browser semantics. Relative and root-relative paths such as `bundle/images/backgrounds/world-overview/{z}/{x}/{y}.jpg` or `/imagery/ortho/{z}/{x}/{y}.jpg` work immediately when your web server exposes those paths. Raw server filesystem paths are not supported in `config.json`; publish them through static aliases or reverse-proxy routes instead.

If an XYZ or WMS background needs HTTP authentication, add a `headers` object to that background entry. Erdblick attaches those headers to tile, metadata, and WMS image requests. The remote service must still allow those custom headers via CORS if it is served from another origin.

WMS backgrounds are currently marked experimental in the UI because they rely on deck.gl’s experimental `WMSLayer`. They are intended for 2D use first and may not behave correctly in pitched 3D views.

## Browser and platform notes

A few practical browser and platform choices can make erdblick feel noticeably smoother and more reliable:

- Chromium-based browsers usually offer the highest WebGL throughput. Firefox and Safari work but may require higher tile limits to reach the same detail levels.
- Enable GPU acceleration in the browser to keep deck.gl responsive.
- Always serve the bundle through HTTP. Opening `index.html` directly from the filesystem fails because the UI fetches `/static-config/config.json` via XHR.
- In air-gapped deployments, host erdblick and the mapget backend on the same LAN and point `config.json` to internal URLs for external resources so the UI avoids external lookups.
