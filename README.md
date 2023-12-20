# erdblick 🌍

`erdblick` is a dynamic mapviewer built on the `mapget` feature service.

> **Warning ⚠️**: Erdblick is still under active development and hasn't reached its final form. However, we'd love to hear your feedback during this phase.

**Capabilities:** 🛠️

* 🗺️ View map layers from a specific [`mapget`](https://github.com/klebert-engineering/mapget) server.
* 🎨 Define visual styles for map layers through style-sheets, translating specific features into visual elements in both 2D and 3D.
* 🏔️ Experience 3D features and terrains with a flexible 3D camera powered by [CesiumJS](https://github.com/CesiumGS/cesium/).
* ✍️ Edit map layer style sheets in real-time directly from the front-end **(Planned)**.
* 🔍 Select multiple features at once using filter or lasso selection tools **(Planned)**.
* 🖼️ Utilize split-screen panes for optional overlay or synchronized navigation with an adjustable splitter **(Planned)**.
* 🔎 View multiple map layer tile zoom levels all at once **(Planned)**.

![mapget ui](./docs/erdblick.png)

## Setup

Ready to try out the latest version? 
While the Desktop app is still work-in-progress, swing by the [Release Page](https://github.com/Klebert-Engineering/erdblick/releases) to grab the newest build. 
Currently, `erdblick` is made to be served by a [`mapget`](https://github.com/klebert-engineering/mapget) server, 
so make sure to serve it up with the `mapget serve` command. 
Not sure how to do that? Start off with a simple `pip install mapget` and then fire away with 
```bash
mapget serve -w <path-to-unpacked-erdblick>
```

If you would like to build erdblick from its source code, you would need to install the required dependencies 
and run the following commands prior to starting up a mapget server:
```bash
cd <path-to-cloned-repo>
npm install
ng build
```

#### Required dependencies

To sucessfully build from the source code, the following dependencies are prerequisite:

| Dependency | Version |
|------------|---------|
| Node.js    | 21.3.0+ |
| npm        | 10.2.4+ |

## Styling System

Erdblick styles are defined as *YAML*-files, which must have a `rules` key that contains an array of
feature visualisation rule objects. During runtime, a feature will be visualised according to each
rule that matches it.

<details>
<summary>Show details</summary>

> **Note ⚠️:** While the mature product envisions a rich UI with the ability
> to edit and toggle multiple style sheets, the current alpha version loads
> its style sheet from the hard-coded path [static/styles/demo-style.yaml](static/styles/demo-style.yaml).

Each rule within the YAML `rules` array can have the following fields. Any field marked with __`*`__ is optional:

| Field                 | Description                                                                                          | Type                                                       | Example Value        |
|-----------------------|------------------------------------------------------------------------------------------------------|------------------------------------------------------------|----------------------|
| `geometry`            | List of feature geometry type(s) the rule applies to.                                                | At least one of `"point"`,`"mesh"`, `"line"`, `"polygon"`. | `["point", "mesh"]`  |
| `type`__*__           | A regular expression to match against a feature type.                                                | String                                                     | `"Lane\|Boundary"`   |
| `filter`__*__         | A [simfil](https://github.com/klebert-engineering/simfil) filter expression.                         | String                                                     | `*roadClass == 4`    |
| `color`__*__          | A hexadecimal color code or [CSS color name](https://www.w3.org/wiki/CSS/Properties/color/keywords). | String                                                     | `"#FF5733"`, `red`   |
| `opacity`__*__        | A float value between 0 and 1 indicating the opacity.                                                | Float                                                      | `0.8`                |
| `width`__*__          | Specifies the line width or point diameter (default in pixels).                                      | Float                                                      | `4.5`                |
| `flat`__*__           | Clamps the feature to the ground (Does not work for meshes).                                         | Boolean                                                    | `true`, `false`      |
| `outline-color`__*__  | Point outline color.                                                                                 | String                                                     | `green`, `#fff`      |
| `outline-width`__*__  | Point outline width in px.                                                                           | Float                                                      | `3.6`                |
| `near-far-scale`__*__ | For points, indicate (`near-alt-meters`, `near-scale`, `far-alt-meters`, `far-scale`).               | Array of four Floats.                                      | `[1.5e2,10,8.0e6,0]` |
| `first-of`__*__       | Mark a rule as a parent of a fallback rule list. See description below.                              | Array of Rule objects.                                     | See example below.   |

**About `first-of`:**

Normally, all style rules from a style sheet are naively applied to all matching features.
However, usually, it will be sufficient if only the first matching rule from a list
is applied. This allows a simple fallback rule at the bottom of the list. For this purpose,
the `first-of` style rule field exists. It may be applied as follows:

```yaml
rules:
- type: Road
  first-of:
    - (subrule-1...)
    - (subrule-2...)
    - (subrule-n)
```

Note, that all attributes except for `type`, `filter` and `first-of` are propagated
from the parent rule to the subrules. For example, a parent rule `color` will be applied
to the child, unless the child overrides the color. It is explicitly allowed
that sub-rules may have sub-rules themselves.

**A brief example:**

```yaml
rules:
  - geometry:
      - point
      - mesh
    type: "Landmark"
    filter: "properties.someProperty == someValue"
    color: "#FF5733"
    opacity: 0.8
    width: 4.5
  - geometry:
      - line
      - polygon
    type: "Boundary"
    color: "#33FF57"
```

</details>

## Build instructions (Linux-only)

<details>
<summary>Show instructions</summary>

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

</details>

## Concepts

As the project is still very much under development, we've gathered
some resources that should give you a clearer picture of what we're aiming
for with the mature product. Feel free to take a look.

<details>
<summary>UI Mocks</summary>

You'll find a series of mockups showcasing our proposed user interface in various scenarios.
Keep an eye out for notes within the images - they provide extra insight into specific features.

#### Overview

![overview](docs/erdblick_ui_overview.svg)

#### Search Bar

![search](docs/erdblick_ui_search.svg)

#### Selection View

![selection-view](docs/erdblick_ui_sel.svg)

#### Split View

![split-view](docs/erdblick_ui_split.svg)

</details>

<details>
<summary>Initial Architecture UML</summary>

### Architecture

Second is a UML diagram giving you an overview of our emerging architecture.
Look out for comments within the diagram - they're there to give you a bit more
context on how the parts fit together.

![arch](docs/erdblick_uml.svg)

Keep in mind, that these concepts are always up for changing.

</details>