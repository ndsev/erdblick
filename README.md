# erdblick 🌍

`erdblick` is a dynamic mapviewer built on the `mapget` feature service.

**Capabilities:** 🛠️

* 🗺️ View map layers from a specific [`mapget`](https://github.com/ndsev/mapget) server.
* 🎨 Define visual styles for map layers through style-sheets, translating specific features into visual elements in both 2D and 3D.
* 🏔️ Experience 3D features and terrains with a flexible 3D camera powered by [CesiumJS](https://github.com/CesiumGS/cesium/).
* ✍️ Edit map layer style sheets in real-time directly from the front-end.
* 🔍 Select multiple features at once using filter or lasso selection tools **(Planned)**.
* 🖼️ Utilize split-screen panes for optional overlay or synchronized navigation with an adjustable splitter **(Planned)**.
* 🔎 View multiple map layer tile zoom levels all at once **(Planned)**.

![mapget ui](./docs/erdblick.png)

## Build Modes

erdblick can be built in two different modes to suit different use cases:

### Full Mode (Default)

The complete erdblick experience with all features enabled:

* GUI for data sources and styles
* Interactive feature selection and inspection
* Style editing capabilities
* Search functionality
* Coordinate display
* Statistics and preferences panels
* Full keyboard navigation support

### Visualization-Only Mode

A streamlined version focused purely on map visualization:

* Map display with all data sources and styles that are reflected in the URL used to open the viewer
* Basic camera controls
* No advanced features like search and inspection
* Perfect for embedding or usage for demo purposes

This mode can be built using:

```bash
./build-ui.bash /path/to/source visualization-only
```

## Setup

Ready to try out the latest version?
While the Desktop app is still work-in-progress, swing by the [Release Page](https://github.com/ndsev/erdblick/releases) to grab the newest build.
Currently, `erdblick` is made to be served by a [`mapget`](https://github.com/ndsev/mapget) server,
so make sure to serve it up with the `mapget serve` command.
Not sure how to do that? Start off with a simple `pip install mapget` and then fire away with
```bash
mapget serve -w <path-to-unpacked-erdblick>
```

## Styling System

Erdblick styles are defined as *YAML*-files, which must have a `rules` key that contains an array of
feature visualisation rule objects. During runtime, a feature will be visualised according to each
rule that matches it.

### Custom Style Declarations

It is possible to apply own custom styles easily.
On build, Erdblick automatically picks up `.yaml` style files from `config/styles` directory (where you can drop your custom files)
and bundles them in `static/bundle/styles` (in case you are using a pre-built Erdblick distribution,
you can directly put your styles in `static/bundle/styles`).

For Erdblick to apply custom styles, it expects the following declarations for the styles in `config/config.json`
(in case you are using a pre-built Erdblick distribution, you can directly create your configuration in `static/config.json`):
```json
{
   "styles": [
       { "id": "Your Style ID", "url": "style.yaml" },
       { "id": "Your Style ID2", "url": "style_2.yaml" }
   ]
}
```
where `url` field must be a path relative to `config/styles` and `id` is used to identify the particular style in GUI.

It is also possible to export and import styles in GUI. Styles imported this way will persist in the local storage of the browser.

### Editing Styles via Erdblick

Both bundled and imported styles can be modified directly via a GUI editor included in Erdblick.
If a style was modified this way, it will persist in the `local storage` of the browser
(if the `local storage` is cleared or reset, all of the modifications will be reset as well;
in case you would like to clear the styles yourself, you can do that via the preferences panel.

The style editor automatically verifies YAML for syntax parsing errors and provides basic autocomplete.

### Style Definitions

Each rule within the YAML `rules` array can have the following fields:

### Style Rule Fields

Style rules can include various fields organized into the following categories:

#### Basic Rule Properties

These properties define the fundamental matching criteria for when a style rule should be applied to a feature.

| Field | Description | Type | Example |
|-------|-------------|------|---------|
| `geometry` | List of geometry type(s) or single type the rule applies to, when aspect is `attribute` then this is about the validity geometry | At least one of `"point"`,`"mesh"`, `"line"`, `"polygon"` | `["point", "mesh"]`, `line` |
| `aspect` | Specifies the aspect to which the rule applies | String: `"feature"`, `"relation"`, or `"attribute"` | `"feature"` |
| `mode` | Determines when the style is applied based on feature interaction state. When omitted or set to `none`, the style applies to features in their default state (not selected or hovered). | String: `"none"`, `"hover"`, or `"selection"` | `"hover"` |
| `type` | Regular expression to match against a feature type | String | `"Lane\|Boundary"` |
| `filter` | [Simfil](https://github.com/Klebert-Engineering/simfil/blob/main/simfil-language.md) filter expression over feature's JSON expression. | String | `*roadClass == 4` |
| `selectable` | Indicates if the feature is selectable | Boolean | `true` |

#### General Visual Properties

Core visual properties that can be applied to any geometry type to control its appearance.

| Field | Description | Type | Example |
|-------|-------------|------|---------|
| `color` | Hex color code or CSS color name | String | `"#FF5733"`, `red` |
| `color-expression` | Simfil expression returning color value | String | `isBridge and "#FF5733" or "black"` |
| `opacity` | Opacity value between 0 and 1 | Float | `0.8` |
| `width` | Line width or point diameter | Float | `4.5` |
| `flat` | Clamps feature to ground | Boolean | `true` |
| `offset` | Fixed offset in meters | Array of three Floats | `[0, 0, 5]` |

#### Point-Specific Properties

Special properties that only apply to point geometries, allowing detailed control of point visualization.

| Field | Description | Type | Example |
|-------|-------------|------|---------|
| `outline-color` | Point outline color | String | `green` |
| `outline-width` | Point outline width in px | Float | `3.6` |
| `point-merge-grid-cell` | Merging tolerance: a threshold defined as the WGS84 (with elevation) delta; points within this range are displayed and selectable as a single point | Array of three Floats | `[0.000000084, 0.000000084, 0.01]` |
| `near-far-scale` | Point scaling parameters | Array of four Floats | `[1.5e2,10,8.0e6,0]` |
| `icon-url` | Static icon URL | String | `/icons/unknown.png` |
| `icon-url-expression` | Dynamic icon URL expression | String | `category == 5 and "/icons/ev-charging.png" or ""` |

#### Line-Specific Properties

Properties specific to line geometries that control line appearance and decoration.

| Field | Description | Type | Example |
|-------|-------------|------|---------|
| `arrow` | Type of arrowhead | String: `none`, `forward`, `backward`, `double` | `forward` |
| `arrow-expression` | Dynamic arrow type | String | `select(arr("single", "double"), 1)` |
| `dashed` | Enable line dashing | Boolean | `true` |
| `gap-color` | Color between dashes | String | `blue` |
| `dash-length` | Size of dash in pixels | Integer | `16` |
| `dash-pattern` | 16-bit dash pattern | Integer | `255` |

#### Relation Properties

Properties that control how relationships between features are visualized and processed.

| Field | Description | Type | Example |
|-------|-------------|------|---------|
| `relation-type` | Relation type matcher | String | `"connectedFrom\|connectedTo"` |
| `relation-line-height-offset` | Vertical offset in meters | Float | `0.5` |
| `relation-line-end-markers` | End marker styling | Sub-rule object | `{ color: "black", width: 4 }` |
| `relation-source-style` | Source geometry styling | Sub-rule object | `{ color: "orange", width: 2 }` |
| `relation-target-style` | Target geometry styling | Sub-rule object | `{ opacity: 0 }` |
| `relation-recursive` | Enable recursive resolution | Boolean | `true` |
| `relation-merge-twoway` | Merge bidirectional relations | Boolean | `true` |

#### Attribute Properties

Properties that determine how feature attributes are matched.

| Field | Description | Type | Example |
|-------|-------------|------|---------|
| `attribute-type` | Attribute type matcher | String | `SPEED_LIMIT_.*` |
| `attribute-layer-type` | Layer type matcher | String | `Road.*Layer` |
| `attribute-validity-geom` | Validity geometry requirement | String: `required`, `none`, `any` | `required` |

#### Label Properties

Properties that control the appearance and positioning of text labels on features.

| Field | Description | Type | Example |
|-------|-------------|------|---------|
| `label-text` | Static label text | String | `No speed limit` |
| `label-text-expression` | Dynamic label text | String | `**.speedLimitKmh` |
| `label-color` | Text color | String | `#00ccdd` |
| `label-outline-color` | Text outline color | String | `#111111` |
| `label-outline-width` | Text outline width | Float | `1.0` |
| `label-font` | CSS font property | String | `24px Helvetica` |
| `label-background-color` | Label background | String | `#000000` |
| `label-background-padding` | Background padding | Pair of Integers | `[7, 5]` |
| `label-style` | Label drawing style | String: `FILL`, `OUTLINE`, `FILL_AND_OUTLINE` | `FILL` |
| `label-scale` | Label size multiplier | Float | `1.0` |
| `label-horizontal-origin` | Horizontal alignment | String: `LEFT`, `CENTER`, `RIGHT` | `LEFT` |
| `label-vertical-origin` | Vertical alignment | String: `ABOVE`, `BELOW`, `CENTER`, `BASELINE` | `BASELINE` |
| `label-pixel-offset` | Screen space offset | Pair of Floats | `[5.0, 30.0]` |
| `label-eye-offset` | 3D eye coordinates offset | Tuple of three Floats | `[5.0, 10.0, 15.0]` |

#### Distance-Based Properties

Properties that control how visualization changes based on camera distance.

| Field | Description | Type | Example |
|-------|-------------|------|---------|
| `translucency-by-distance` | Distance-based transparency | Array of four Floats | `[1.5e2, 3, 8.0e6, 0.0]` |
| `scale-by-distance` | Distance-based scaling | Array of four Floats | `[1.5e2, 3, 8.0e6, 0.0]` |
| `offset-scale-by-distance` | Distance-based offset scaling | Array of four Floats | `[1.5e2, 3, 8.0e6, 0.0]` |

#### Rule Organization

Properties that control how multiple style rules are combined and prioritized.

| Field | Description | Type | Example |
|-------|-------------|------|---------|
| `first-of` | Parent of fallback rule list | Array of Rule objects | See "About first-of" section |

### Expression Evaluation Context

Erdblick utilizes Simfil expressions to dynamically determine styling properties based on feature attributes and contextual variables.

How It Works:

* Evaluation Context: Each expression is evaluated within a context that includes variables related to the current feature, relation, or attribute being styled.
* Context Variables: Depending on the aspect of the rule (feature, relation, or attribute), different variables are available for expression evaluation.

Available Context Variables:

For aspect `feature`:

* `$feature`: Represents the current feature.
* `$mergeCount`: (If point-merge-grid-cell is set) Indicates the number of merged points.
* Any top-level field of the feature

For aspect `relation`:

* `$source`: The source feature of the relation.
* `$target`: The target feature of the relation.
* `$twoway`: Indicates if the relation is bidirectional.
* `name`: The name/type of the relation.
* `sourceValidity`: The validity geometry of the source feature, if available.
* `targetValidity`: The validity geometry of the target feature, if available.

For aspect `attribute`:

* `$name`: The name of the attribute.
* `$layer`: The layer name of the attribute.
* `$feature`: The feature to which the attribute belongs.
* `direction`: The direction of the attribute, if set.
* `validity`: The validity geometry of the attribute, if set.
* Any nested fields within the attribute

### Labels in Erdblick

In Erdblick, labels are used to add textual information to the visualized geometries.
Labels are always visualized in addition to the geometry itself and are positioned at
the visual center of the geometry. For a label to be displayed, the `label-text` or
`label-text-expression` property must be set in the style definition.
When set, Erdblick renders the label according to the defined style properties,
such as `label-color`, `label-font`, `label-scale`, etc.

Labels can be applied to any geometry type and are particularly useful for providing contextual information,
such as names, identifiers, or any other relevant data associated with the feature.

**Label Example:**

```yaml
rules:
  - geometry:
      - point
      - line
    type: "City|Road"
    color: "#FF5733"
    label-text-expression: "**.name"
    label-color: "white"
    label-outline-color: "black"
    label-font: "14px Arial"
    label-style: "FILL"
    label-scale: 1.2
```

In this example, labels are applied to both point and line geometries representing
cities and roads. The label text is dynamically generated from the feature's name
attribute. The labels are styled with a white fill color, a black outline, and are
scaled up by a factor of 1.2 for better visibility.

### Style Options

In addition to the `rules` section, a style sheet may have a top-level `options` key.
Under this key, variables may be defined for the style sheet which can be controlled
by the user. Each `option` entry may have the following fields:

* `label`: UI label for the control to change the option value.
* `id`: Simfil variable name, under which the current option value will be available in
   different style rule expressions, e.g. `filter` or `color-expression` etc.
* `type`: Data type for the option variable. Both the default and currently the only allowed value is `bool`, which will be shown to the user as a checkbox.
* `default`: Default value for the option.

### Relation Styling

In Erdblick, relation styling is used to visualize relationships between different features.
This is especially useful for illustrating connections, flows, or hierarchies between elements in the map.
A rule is run for all relations of a matching feature by setting `aspect: relation`.
The geometric primitive that is used to visualize the relation is a line from the center
of the source validity geometry (the default validity is first source feature geometry) to the center
of the target validity geometry. The visualized relations may be filtered by type name
using the `relation-type` regular expression.

For relations, style expressions (e.g. `color-expression`) are evaluated in a context which has the following variables:

* `$source`: Source feature.
* `$target`: Target feature.
* `$twoway`: Variable indicating whether the relation is bidirectional.
* `name`: Name of the relation type.
* `sourceValidity`: Source validity geometry if set.
* `targetValidity`: Target validity geometry if set.

When visualizing relations recursively using a rule that has
the `highlight` mode, the recursion will be performed
until the selected feature tile's border is reached. Any
relations across the border are then resolved once using
a mapget `locate`-call.

**Relation Styling Example:**

```yaml
rules:
  - type: LaneGroup
    aspect: relation
    mode: highlight
    color: red
    width: 20
    arrow: double
    opacity: 0.9
    relation-type: "nextLaneGroup|prevLaneGroup"
    relation-recursive: true
    relation-merge-twoway: true
    relation-line-height-offset: 10
    relation-line-end-markers:
      color: black
      width: 4
```

### Attribute Styling

Using `aspect: attribute`, a styling rule can be used to visualize feature attributes
that are stored in attribute layers. The rule will then be used to visualize the validity
geometry of the attribute, or the attribute's feature's first geometry as a fallback.
The visualized attributes may be filtered using the `attribute-type` and `attribute-layer-type`
regular expressions. You may also select specifically for attributes which do or do not have
their own validity geometry, by setting the `attribute-validity-geom` field.

For attributes, style expressions (e.g. `color-expression`) are evaluated in a context which has the following variables:

* `$name`: The attribute name.
* `$layer`: The layer name of the attribute.
* `$feature`: The feature of the attribute.
* `validity`: Attribute validity collection if available.
* Top-level fields of the attribute with their nested members, e.g. `attributeValue.speedLimitKmh`.

**Note:** To avoid colliding geometries when multiple attributes are visualized for the same feature,
set the `offset` field. The spatial `offset` will be multiplied, so it is possible to "stack" attributes
over a feature.

**A note on hover/selection semantics:** The semantics of setting `mode: hover` vs.
`mode: selection` for an attribute are a bit tricky: Hover styles for one specific attribute are applied,
if the user hovers over the attribute in the attribute panel. Selection styles on the other hand are
applied, if the user selects the feature which contains the attribute.

### About Merged Point Visualizations

By setting `point-merge-grid-cell`, a tolerance may be defined which allows merging the visual representations
of point features which share the same 3D spatial cell, map, layer, and style rule. This has two advantages:

* **Multi-Selection**: When selecting the merged representation, a multi-selection of all merged features happens.
* **Logical Evaluation using `$mergeCount`**: In some map formats, it may be desirable to apply a style based on the number of merged points.
  This may be done to display a warning, or to check a matching requirement.
  To this end, the `$mergeCount` variable is injected into each simfil evaluation context of a merged-point style rule.
  Check out the default style for an example.

### About `first-of`

Normally, all style rules from a style sheet are naively applied to all matching features.
However, usually, it will be sufficient if only the first matching rule from a list


is applied. This allows a simple fallback rule at the bottom of the list. For this purpose,
the `first-of` style rule field exists. It may be applied as follows:

**How `first-of` Works:**

* When a rule contains the `first-of` field, Erdblick will evaluate each sub-rule in the order they are listed.
* Once a sub-rule matches a feature, Erdblick applies that sub-rule exclusively and skips the remaining sub-rules within the `first-of` group.
* This mechanism prevents multiple styles from being applied to the same feature, ensuring that the most specific applicable style is used.

**Inherited Properties:**

* All attributes except for `type`, `filter`, and `first-of` are propagated from the parent rule to the sub-rules.
* For example, if the parent rule defines a `color`, sub-rules inherit this color unless they explicitly override it.

**Example Usage:**

```yaml
rules:
  - type: Road
    first-of:
      - filter: "speedLimit > 100"
        color: "red"
      - filter: "speedLimit > 60"
        color: "orange"
      - filter: "speedLimit <= 60"
        color: "green"
```

In this example:

* Roads with a speedLimit greater than 100 are colored red.
* If the speedLimit is not greater than 100 but is greater than 60, they are colored orange.
* All other roads are colored green

## Build instructions (Linux-only)

<details>
<summary>Show instructions</summary>

Make sure that these prerequisite dependencies are installed:

| Dependency | Version |
|------------|---------|
| `node`     | 21.3.0+ |
| `npm`      | 10.2.4+ |
| `cmake`    | 3.24+   |

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

You will find the resulting built web app under the directory `./static`.

You can also build the `erdblick-core` library with a standard C++ compiler
in an IDE of your choice. This is also useful to run the unit-tests.

### Frontend Unit Tests

Vitest powers the Angular frontend unit tests. After installing the npm dependencies:

```bash
npm install
npm run test:vitest
```

Vitest can also watch for changes while you iterate:

```bash
npm run test:vitest -- --watch
```

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
