# erdblick 🌍

`erdblick` is a Cesium-based map UI that connects to [`mapget`](https://github.com/ndsev/mapget) servers, renders NDS.Live and GeoJSON tiles, and exposes live style editing plus advanced inspection tools. MapViewer ships with erdblick pre-integrated, but the UI also runs as a standalone bundle.

## Documentation

- [Erdblick User Guide](docs/erdblick-user-guide.md) – setup, UI basics, search, inspection, split view, troubleshooting, and more.
- [Erdblick Development Guide](docs/erdblick-dev-guide.md) – architecture overview, build instructions, tile/rendering pipelines, and debugging tips.

Those documents now host the detailed instructions that previously lived in this README. Use them as a sitemap when contributing.

## Build Modes

| Mode | Description |
| --- | --- |
| Full | Default build that includes maps/layers panel, style editor, search, inspector, and diagnostics. |
| Visualization-only | Lightweight bundle for kiosks or embeds. Only the canvas renders; configuration is provided via URL parameters or `config.json`. |

Select a mode when running `./build-ui.bash <output-folder> [visualization-only]`. Integrations such as the MapViewer container use the `ERDBLICK_VARIANT` environment variable to pick the variant they embed. The [Setup Guide](docs/erdblick-setup.md) documents both workflows.

## Quick Start

```bash
pip install mapget
./build-ui.bash ~/tmp/erdblick-dist
mapget serve -w ~/tmp/erdblick-dist
```

Open the printed localhost URL, then configure your mapget backend (via its YAML config or management API) so `/sources` advertises the maps you need. Products such as MapViewer already ship with a prebuilt erdblick bundle under `/app/erdblick`, so those users can skip the build step entirely.

## Styling System

- Styles live in `config/styles/*.yaml` and can be edited inside the UI.
- The rules reference Simfil expressions (`color-expression`, `filter`, etc.) and can target features, relations, or attribute geometries.
- Import/export buttons store styles in browser `localStorage` for quick experimentation.

Read the [Style System Guide](docs/erdblick-stylesystem.md) for the complete YAML reference and GUI walkthrough.

## Screenshots

![erdblick UI](docs/erdblick.png)

Additional callouts and placeholders live alongside the dedicated guide files so test reference screenshots stay in sync with the docs.
