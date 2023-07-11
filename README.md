# erdblick

`erdblick` is a mapviewer based on the `mapget` feature service.

Capabilities:

* View map layers from a specific [`mapget`](https://github.com/klebert-engineering/mapget) server.
* Define a map layer as a style-sheet, which translates specific features to specific visual elements in 2D or 3D.
* View 3D features and terrain with a freely controllable 3D camera.
* Edit map layer style sheets in real-time in the front-end.
* Select multiple features simultaneuosly, with a filter or lasso selection.
* Create split-screen panes for optional overlayed or synced navigation with a splitter.
* View multiple map layer tile zoom levels simultaneously.

## Setup

Ready to get your hands on the freshest `erdblick` web files? Swing by the [Release Page](https://github.com/Klebert-Engineering/erdblick/releases) to grab the latest pack. Keep in mind, `erdblick` is made to be buddies with the [`mapget`](https://github.com/klebert-engineering/mapget) server, so make sure to serve it up with the `mapget serve` command. Not sure how to do that? Start off with a simple `pip install mapget` and then fire away with `mapget serve -w path-to-unpacked-erdblick`.

![mapget alpha ui](./docs/erdblick-alpha.png)

## Build instructions (Linux-only)

Run the setup script once to pull Emscripten SDK:

```bash
./ci/00_linux_setup.bash
```

To build the project, run:

```bash
./ci/10_linux_build.bash
```

To rebuild the project (skipping checkouts and CMake initialization), run:

```bash
./ci/20_linux_rebuild.bash
```

You can also build the `erdblick-core` library with a standard C++ compiler
in an IDE of your choice. This is also useful to run the unit-tests.

## Conceptual Background

Our Erdblick project is still very much under development. We've gathered
some resources that should give you a clearer picture of what we're aiming
for. Feel free to take a look.

### UI Mocks

First, you'll find a series of mockups showcasing our proposed user interface in various scenarios.
Keep an eye out for notes within the images - they provide extra insight into specific features.

#### Overview

![overview](docs/erdblick_ui_overview.svg)

#### Search Bar

![search](docs/erdblick_ui_search.svg)

#### Selection View

![selection-view](docs/erdblick_ui_sel.svg)

#### Split View

![split-view](docs/erdblick_ui_split.svg)

### Architecture

Second is a UML diagram giving you an overview of our emerging architecture.
Look out for comments within the diagram - they're there to give you a bit more
context on how the parts fit together.

![arch](docs/erdblick_uml.svg)

Keep in mind, that these concepts are always up for changing.