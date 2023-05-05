# erdblick

`erdblick` is a mapviewer based on the `mapget` feature service.

Capabilities:

* View map layers from a specific `mapget` cache server.
* Define a map layer as a style-sheet, which translates specific features to specific visual elements in 2D or 3D.
* View 3D features and terrain with a freely controllable 3D camera.
* Edit map layer style sheets in real-time in the front-end.
* Select multiple features simultaneuosly, with a filter or lasso selection.
* Create split-screen panes for optional overlayed or synced navigation with a splitter.
* View multiple map layer tile zoom levels simultaneously.

## Overview

![overview](docs/erdblick_ui_overview.svg)

## Search Bar

![overview](docs/erdblick_ui_search.svg)

## Selection View

![split-view](docs/erdblick_ui_sel.svg)

## Split View

![split-view](docs/erdblick_ui_split.svg)

## Architecture

![arch](docs/erdblick_uml.svg)

## Build instructions (Linux-only)

Run the setup script once to pull Emscripten SDK:

```bash
./ci/00_linux_setup.bash
```

To (re-)build the project, run:

```bash
./ci/10_linux_build.bash
```

Afterwards, view the static website under ``build/index.html``.

To set up the build environment in CLion, first run the setup script.
Then follow the instructions here:

[https://stackoverflow.com/questions/51868832/integrate-emscripten-in-clion](https://stackoverflow.com/questions/51868832/integrate-emscripten-in-clion)

Configure the custom CMake toolchain with the following options.

**C compiler**: ci/emsdk/upstream/emscripten/emcc

**C++ compiler**: ci/emsdk/upstream/emscripten/em++