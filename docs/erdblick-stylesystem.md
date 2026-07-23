# Erdblick Style System

Erdblick stylesheets are YAML presentation programs. Schema version 2 is
planned into mapget `/filter` channels and rendered from immutable
`TileSubsetLayer` values.

![erdblick UI](screenshots/style-controls.png)

## Managing Styles in the UI

Most day-to-day style work happens directly inside the Styles dialog, where
you can toggle, edit, and reset style sheets without touching files on disk:

1. Open the Styles dialog via **Edit -> Styles Configurator**.
2. Activate or deactivate style sheets to control which rules run.
3. Use the pencil button for live YAML editing, validation, completion,
   import, and export.
4. Reset browser-stored versions from Preferences when required.

Built-in styles edited locally show a **Modified** tag whose comparison dialog
shows the shipped version. Styles supplied through `additionalStyles` show an
**Additional** tag and can be compared with an overridden base style.

The **Maps & Layers** panel also exposes per-layer style options. Hovering or
focusing an option highlights the contiguous group supplied by the same style
sheet. The first visible row in that group has a brush button which opens the
sheet in the editor.

## YAML Styles and Search Result Styles

YAML style sheets are persistent project-wide rules loaded from the bundle,
deployment configuration, additional style locations, or browser-imported
YAML. Search result styles belong to one feature-search session and are stored
with its search state. Both use the same rendering primitives and SIMFIL
expression model.

## Document shape

```yaml
name: Roads
version: 2

options:
  - id: showRoads
    label: Show roads
    type: boolean
    default: true

rules:
  - type: Road
    filter: "showRoads and properties.frc <= 4"
    geometry: line
    geometry-name: centerline
    color: "#4f81bd"
    width: 2
```

`version: 2` is required. The removed `aspect`, `stage`, and `lod` fields are
validation errors. Use `scope`, semantic `geometry-name`, and explicit
attribute filters.

Options become typed SIMFIL bindings. They can participate in filters and
presentation expressions without rewriting the stylesheet.

## One top-level rule, one channel

Each applicable top-level rule becomes exactly one ordered `/filter` channel.
Channels are not combined for compression. The channel transports only the
geometry and projected scalar expressions needed to evaluate that rule tree.

The planner separates:

- `featureFilter`: root-feature admission;
- `entryFilter`: attribute/relation terminal admission;
- `featureFields`: expressions evaluated on the feature;
- `entryFields`: expressions evaluated on the terminal context.

Mapget schema-compiles all four lists in their real contexts. Styles do not use
search-query normalization.

## Scopes

`scope` belongs to the top-level rule:

- `feature` (default);
- `attribute`;
- `relation`.

Nested `first-of`/`all-of` rules may not change scope. A single channel never
mixes feature and attribute terminal rows.

A top-level relation rule may not contain `first-of` or `all-of`; its
`relation-source-style` and `relation-target-style` are feature-style trees and
may use branches.

## Matching fields

Common admission fields:

| Field | Meaning |
|---|---|
| `type` | Feature type name or accepted type pattern. |
| `filter` | SIMFIL feature-root filter. |
| `mode` | Regular, `hover`, or `selection` pass. |
| `fidelity` | `low`, `high`, or any presentation fidelity. |
| `geometry` | One type or list: point, line, polygon, mesh, etc. |
| `geometry-name` | Exact semantic name, or `*`/omission for wildcard. |
| `selectable` | Whether generated primitives participate in selection. |

Geometry type and name are independent selectors.

```yaml
- type: Road
  geometry: line
  geometry-name: topology
  fidelity: low
  filter: "any(properties.layer.**.FUNCTIONAL_ROAD_CLASS.** <= 4)"
```

Mapget does not interpret `topology` as low fidelity. Erdblick chose the
low-fidelity rule; the channel simply asks for a semantic geometry and an
ordinary feature predicate.

## Branches

`first-of` selects the first matching child for rendering:

```yaml
- type: Road
  geometry: line
  first-of:
    - filter: "properties.frc <= 2"
      width: 4
    - filter: "properties.frc <= 5"
      width: 2
```

`all-of` emits every matching child:

```yaml
- type: Boundary
  geometry: line
  all-of:
    - color: white
      width: 5
    - color: black
      width: 2
      dashed: true
```

For server admission, both trees need the union of possible leaves. The
planner recursively builds:

```text
own-filter AND (child-1-eligibility OR child-2-eligibility OR ...)
```

The renderer retains the different first/all semantics using projected fields.
This avoids one channel per flattened leaf while still excluding features
which no descendant could render.

One rule cannot define both branch kinds.

## Presentation fields

Common primitive fields include:

- `color`, `color-expression`, or `color-scale`;
- `opacity`;
- `width` and optional `width-scale`;
- `offset` and `offset-increment`;
- `flat`, `billboard`, and `depth-test`;
- `dashed`, `dash-length`, `dash-pattern`, and `gap-color`;
- `arrow` / `arrow-expression`;
- outline color/width;
- icon URL/expression;
- label text/expression, font, color, outline, background, padding, origin,
  pixel offset, and height reference.

Literal values are resolved without projection. Every expression-backed field
is collected by the planner and transported in the appropriate field list.

## Color modes

Exactly one of these may be present:

### Literal color

```yaml
color: orange
```

### Expression color

```yaml
color-expression: "selected and '#ff0000' or '#808080'"
```

Use this for genuinely dynamic color strings, such as the internal selection
color binding.

### Typed color scale

```yaml
color-scale:
  mode: categorical
  expression: "properties.category"
  stops:
    - ["motorway", "#e41a1c"]
    - ["primary", "#377eb8"]
    - ["secondary", "#4daf4a"]
  fallback: gray
```

Stops are `[value, color]` pairs, not a YAML map. This preserves boolean,
numeric, and string key types.

Categorical scales use exact typed equality. Duplicate typed keys are invalid.

```yaml
color-scale:
  mode: linear
  expression: "properties.score"
  stops:
    - [0, blue]
    - [50, yellow]
    - [100, red]
  fallback: gray
```

Linear keys must be finite, numeric, and strictly increasing. Colors are
interpolated between adjacent stops. `fallback` handles null, unsupported
types, and values which cannot be mapped.

Use one scale instead of a palette-only `first-of` chain. Structural
`first-of`/`all-of` trees remain appropriate for geometry, dash composition,
or other compound presentation changes.

## Width scales

`width-scale` maps one projected scalar to a line width or point-radius basis
without creating a `first-of` branch for every category. It uses the same
typed keys and categorical/linear modes as `color-scale`; stop values and the
fallback are finite non-negative numbers. A literal `width` remains the
fallback when `width-scale.fallback` is omitted.

```yaml
width: 1
width-scale:
  mode: categorical
  expression: "properties.roadClass"
  stops:
    - [0, 5]
    - [1, 3]
    - [2, 2]
  fallback: 1
```

When color and width depend on the same expression, use identical expression
text. The style planner then projects one value for both scales.

Per-layer overrides in the Maps & Layers panel map directly to these options. Behind the scenes, erdblick stores the values per `mapId/layerId/styleId` combination, which lets you run different variants across split views or specific layers without cloning the entire style file.
Options from the same style are grouped and highlighted together on hover. Use the brush button on the first visible option in a group to open the owning style sheet.

## Point grouping and `$mergeCount`

Feature-scope point rules can request server grouping:

```yaml
- type: Sign
  geometry: point
  geometry-name: position
  point-merge-grid-cell: [0.000000084, 0.000000084, 0.01]
  color-scale:
    mode: categorical
    expression: "$mergeCount > 1"
    stops:
      - [false, moccasin]
      - [true, red]
    fallback: moccasin
  label-text-expression: "$mergeCount > 1 and ($mergeCount as string) or ''"
```

The planner rewrites `$mergeCount` in projected fields to
`count($features.*)`. Group membership includes feature type, point geometry
type/name, existence of a qualifying point, and the recursively assembled
feature filter.

Initial restrictions:

- feature scope only;
- every concrete leaf must be grouped;
- every leaf must be point-only;
- one identical cell size and compatible geometry-name selector;
- `$mergeCount` cannot influence membership;
- no attribute-validity or multi-input grouping.

A mismatch rejects the plan rather than returning a wrong merge count.

## Attribute rules

```yaml
- type: Road
  scope: attribute
  attribute-type: "SPEED_LIMIT"
  attribute-layer-type: "speedProfile"
  attribute-filter: "valueKph > 50"
  attribute-validity-geom: required
  geometry: line
  geometry-name: centerline
  color: red
  width: 4
```

`filter` still applies to the host feature.
`attribute-filter` applies to the expanded attribute context.

Attribute fields:

| Field | Meaning |
|---|---|
| `attribute-type` | Attribute-name/type pattern. |
| `attribute-layer-type` | Attribute-layer pattern. |
| `attribute-filter` | Entry-context SIMFIL predicate. |
| `attribute-validity-geom` | `any`, `required`, or `none`. |

Expression context adds `$feature`, `$layer`, `$name`, `$attributeIndex`,
`$hasValidity`, `$validityIndex`, and `$validityCount`.

The renderer consumes explicit `GeometryCollection` values. Validity-required
rules receive effective validity geometry; a one-element collection is still
a collection.

## Relation rules

```yaml
- type: LaneGroup
  scope: relation
  mode: selection
  filter: "showTopology"
  relation-type: "nextLaneGroup|prevLaneGroup"
  relation-recursive: true
  relation-merge-twoway: true
  geometry: line
  color-scale:
    mode: categorical
    expression: "(($source.tileId != $target.tileId) as int) * 2 + ($twoway as int)"
    stops:
      - [0, red]
      - [1, green]
      - [2, blue]
      - [3, orange]
    fallback: red
  relation-source-style:
    geometry: line
    opacity: 0
    label-text-expression: "$source.laneGroupId"
  relation-target-style:
    geometry: line
    opacity: 0
    label-text-expression: "$target.laneGroupId"
```

Relation fields:

- `relation-type`: stored relation-name regex;
- `relation-recursive`: local recursion plus at most one hop across a tile;
- `relation-merge-twoway`: pair reverse descriptors;
- `relation-line-height-offset`;
- `relation-line-end-markers`;
- `relation-source-style`;
- `relation-target-style`.

Relation expressions can use the relation root plus `$source`, `$target`, and
`$twoway`. Endpoint styles may independently select semantic geometry.
`RelationEntry` carries source/target feature entries and explicit source and
target geometry collections.

Generic bidirectional display uses permanent south-west ownership. If that
owner is outside current coverage, the pair is not rendered. Selection
traversal is root-owned.

## Fidelity

`fidelity: low|high` remains a presentation-only rule gate. The current view
density chooses which set applies. Both use the same complete backend source
tile and `/filter` evaluator.

Do not encode fidelity into mapget geometry names. Choose the semantic
geometry each rule needs, and use explicit source attributes when a
presentation should include fewer features.

## Validation and planner failures

Style validation reports source rule index, property, message, and YAML
location. Important hard failures include:

- schema version other than 2;
- removed `aspect`, `stage`, or `lod`;
- descendant scope changes;
- branches on a top-level relation rule;
- invalid/mixed color modes;
- malformed color-scale stops;
- incompatible point-group leaves;
- invalid relation/attribute regexes.

Planner issues are also rule-indexed. A syntactically valid style can still be
unplannable against a concrete layer—for example when a point-group rule has
no compatible feature types.

## Picking identity

Presentation choices such as highlight mode, fidelity, options, style
identity/order, and rule tree participate in the render signature. Backend
transport identity is only `filterId + generation + output tile`.

Deck picks store `(channel ordinal, typed-entry ordinal)` against the exact
subset retained by the visualization. Nested render-rule and primitive details
stay renderer-local.
