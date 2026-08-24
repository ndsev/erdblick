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
3. Use the pencil button for Quick rule editing or Advanced YAML editing,
   validation, completion, and export.
4. Reset browser-stored versions from Preferences when required.

Built-in styles edited locally show a **Modified** tag whose comparison dialog
shows the shipped version. Styles supplied through `additionalStyles` show an
**Additional** tag and can be compared with an overridden base style.

The **Maps & Layers** panel also exposes per-layer style options. Hovering or
focusing an option highlights the contiguous group supplied by the same style
sheet. The first visible row in that group has a brush button which opens the
sheet in the editor.

The **Edit -> Styles** submenu provides a direct path to a loaded style sheet,
without first opening the complete configurator:

![Direct main-bar path to a loaded style sheet](screenshots/12a-mainbar-direct-style-menu.png)

From **Maps & Layers**, hover or focus an option group and use the brush on its
first row to edit the owning sheet directly:

![Direct style action from a Maps and Layers option group](screenshots/12b-maps-direct-style-action.png)

## YAML Styles and Search Result Styles

YAML style sheets are persistent project-wide rules loaded from the bundle,
deployment configuration, additional style locations, or browser-imported
YAML. A root `category` may be `base` or `search`; omission means `base`.
Category is metadata independent of whether a style is built in, additional,
modified, imported, or visible.

Feature Search saves reusable search-result rules as ordinary imported YAML
with `category: search`, a checked-by-default **Enable this style upon save** choice, and optional exact
layer-ID affinity. Empty affinity applies to any layer. The source is added directly to
the Styles tree, marked with a **Search** tag, persisted through the normal
imported-style mechanism, and exported through the normal style action. Its
canonical source contains flat rules, plus one `showSearchStyle` Boolean option
that defaults on and gates every generated rule. This produces a real per-layer
**Show &lt;stylesheet name&gt;** control in Maps & Layers. The option gate is plumbing: it
is kept out of Quick rule controls and removed when a saved style is copied
back into detached Feature Search rules. The source contains no query, search
scope, map ID, or separate JSON-library identity. Its optional `layer` metadata
affects ordinary rendering but is not copied into a detached Feature Search
rule template.

The root `default` and the generated Boolean option are deliberately distinct.
Root `default` determines whether the whole stylesheet is enabled when first
saved or loaded; `options[].default` seeds the per-layer control once that
stylesheet is active.

The Style Editor has **Quick** and **Advanced** tabs for every loaded base or
search style. Its header switch controls the loaded style's current visible
state directly and intentionally does not rewrite the YAML `default`. Quick
opens all rules initially and exposes the root name, exact layer-affinity IDs, and the rule properties
supported by the current controls, updating the authoritative Advanced YAML on
every change. No selected affinity means Any. A noncanonical regular expression
is presented as Custom and is preserved until the user explicitly replaces it
with exact IDs or clears it. Unsupported properties and rules remain in the
YAML; rule-local help icons explain what Quick preserves or leaves Advanced-only.
Applying either view updates the same stylesheet source.

## Document shape

At the top level, a style sheet contains rendering `rules`, optional `options`,
and optional layer-affine `presets` that name useful combinations of the
owning sheet's Boolean options.

```yaml
name: Roads
category: base
version: 2

options:
  - id: showRoads
    label: Show roads
    type: boolean
    default: true

presets:
  - id: roads-only
    name: Roads only
    values:
      - {optionId: showRoads, value: true}

rules:
  - type: Road
    filter: "showRoads and properties.frc <= 4"
    geometry: line
    geometry-name: centerline
    color: "#4f81bd"
    width: 2
```

`version: 2` is required. `category` accepts only `base` or `search` and
defaults to `base` when absent. The removed `aspect`, `stage`, and scalar `lod`
fields are validation errors. Use `scope`, semantic `geometry-name`, explicit
attribute filters, and the stylesheet LOD fields described below.

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
| `mode` | One pass, or a list of passes: `none`, `hover`, and `selection`. |
| `lod-range` | Inclusive `[minimum, maximum]` stylesheet LOD range from 0 through 7. |
| `fidelity` | Optional shorthand: `low` means `[0, 2]`, `high` means `[3, 7]`, and `any` means `[0, 7]`. |
| `geometry` | One type or list: point, line, polygon, mesh, etc. |
| `geometry-name` | Exact semantic name, or `*`/omission for wildcard. |
| `selectable` | Whether generated primitives participate in selection. |

Geometry type and name are independent selectors.

```yaml
- type: Road
  geometry: line
  geometry-name: topology
  lod-range: [0, 2]
  filter: "any(properties.layer.**.FUNCTIONAL_ROAD_CLASS.** <= 4)"
```

Mapget does not interpret `topology` as an LOD. Erdblick activates this rule at
LOD 0 through 2; the channel simply asks for a semantic geometry and an
ordinary feature predicate. `fidelity` and `lod-range` are alternative
authoring forms and cannot occur on the same rule. Both gates belong only to a
top-level rule.

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
- `polygon-height` and optional `polygon-height-expression`;
- `min-lod-expression` for per-entry GPU visibility within an active rule;
- `surface-shading` for restrained matte lighting on polygon and mesh triangles;
- `offset` and `offset-increment`;
- `z-index` and optional `z-index-expression`;
- `lateral-offset-unit`: `meter`, `meters`, `m`, `pixel`, `pixels`, or `px`;
- literal screen-space `glow` material;
- `flat`, `billboard`, and `depth-test`; paths extrude in the map plane by
  default, while `billboard: true` explicitly requests a constant
  screen-facing width;
- `dashed`, `dash-length`, optional `dash-gap`, `dash-unit`, `dash-pattern`,
  and `gap-color`; `dash-unit` accepts the same metre/pixel aliases as
  `lateral-offset-unit`, defaults to pixels, and omitted `dash-gap` preserves
  the legacy cadence by matching `dash-length`;
- `arrow` / `arrow-expression`;
- outline color/width;
- icon URL/expression;
- label text/expression, font, color, `label-opacity`, outline, background, padding, origin,
  pixel offset, height reference, `label-collision`, and `label-collision-priority`.

Literal values are resolved without projection. Every expression-backed field
is collected by the planner and transported in the appropriate field list.

`polygon-height` extrudes polygon and triangle-mesh surface geometry vertically
in metres. The renderer raises the triangulated roof and materializes walls for
every polygon ring or mesh boundary edge; internal mesh diagonals remain
hidden. `polygon-height-expression` resolves the height per emitted feature,
attribute, or relation and falls back to the literal value when the expression
is undefined. Both forms require finite, non-negative values:

```yaml
geometry: polygon
polygon-height: 3
polygon-height-expression: attributes.layer.BMD.BUILDING_HEIGHT.buildingHeight
```

`surface-shading: true` derives one flat normal from each existing surface
triangle and applies a low-contrast ambient/directional light in 3D. It does
not add geometry, cast shadows, or alter alpha. Flattened 2D rendering and GPU
identity-mask passes retain the exact authored color. The property is opt-in so
diagnostic surfaces and interaction materials remain visually literal:

```yaml
geometry: [polygon, mesh]
surface-shading: true
```

`label-collision: true` lets Deck hide lower-priority labels that overlap
inside one rendered style layer. `label-collision-priority` is an integer from
`-1000` to `1000`; larger values win. Collision filtering is intentionally
opt-in because diagnostic labels often need to remain visible even when they
overlap.

`lateral-offset-unit` changes only the first (lateral) component of `offset`
and `offset-increment`. Meter offsets are baked into projected geometry.
Pixel offsets remain absolute pixels in native renderer buffers. The Deck
adapter divides constant offsets by authored width only at the stock
PathStyleExtension boundary. Generated transitions additionally carry an
explicit local-map XY pixel vector per vertex. Adjacent vectors are packed as
one segment `uvec4`: its four words encode the exact
left/start/end/right vectors as signed 12-bit fixed-point pairs plus a compact
adaptive-scale threshold.
`DeckVariableOffsetPathLayer` displaces the projected
previous/current/next centerline positions before Deck computes extrusion and
joins. Both segments touching a joint therefore see the same three displaced
points instead of extrapolating different neighbours. At far zooms, an inside
offset can consume or reverse the bend's projected forward motion—the cusp of
an inside parallel curve. The native renderer derives a metres-per-pixel
safety threshold from the exact sampled centerline and offset-vector motion.
Sharp and almost-reversing cross-road turns therefore contract sooner than
gentle turns instead of relying on one trim-radius estimate. Every maneuver of
the same host/rule, including a U-turn, uses that common threshold, so the
shader contracts the complete displacement uniformly and preserves the
relative lane stack instead of locally wrinkling or collapsing lanes. Authored
stroke, picking mask, glow mask, and terminal arrow share the same displacement
vector and scale.

A transition geometry is already ordered from the incoming road through the
junction to the outgoing road. The renderer derives its visible side from the
local maneuver: a right turn is right-of-traversal, a left turn is
left-of-traversal, and a transition returning to the same connected end of the
same road is a conventional left-side U-turn. An acute or almost-reversing
transition between different roads remains an ordinary turn. The lateral
`offset` and `offset-increment` values are distances for transition rules;
their YAML sign is only the stable tie-breaker for a straight maneuver.
Connected-end metadata converts the visible path side into each road's
digitization-relative physical side for stack ownership.

Incoming and outgoing physical road sides reserve their slots independently.
The line stays at the incoming distance along that road, rotates its offset
normal while interpolating the lane radius through the junction fillet, and
stays at the outgoing distance thereafter. Interpolating the XY components
directly is incorrect: it shrinks a constant-radius corner and collapses an
opposing-direction U-turn through zero.
This is why generated transitions, unlike constant-offset ordinary paths, use
the packed variable-offset extension. Bend sampling is refined by turn angle,
so sharp joins do not expose a coarse terminal chord. Straight transitions
choose the least occupied compatible pair of sides. A pixel-offset U-turn
keeps a compact, non-overshooting undisplaced bridge; its normal rotates in the
winding that advances with both road legs and produces the visible hairpin
before Deck calculates the join. It inherits the host/rule scale without
contributing the compact bridge's old trim-radius estimate. Arrowheads use the
same terminal vertex and exact local XY pixel vector as their owning leg
through `DeckLocalPixelOffsetExtension`.
The icon shader transforms the local direction directly (without subtracting
two large projected positions), so arrow anchors retain the terminal lateral
offset at Web-Mercator float precision.
Longitudinal and vertical components remain world-space and follow the
respective leg slot.

`z-index` separates coplanar vector geometry without moving it in world
space. Higher values are drawn in front of lower values. An optional
`z-index-expression` supplies the value per emitted feature, attribute, or
relation. The literal `z-index` is its optional fallback when evaluation does
not produce a finite number. If no literal is configured, an undefined
expression leaves that geometry on Deck's stock depth path:

```yaml
z-index-expression: >
  properties.effectiveRenderOrder
```

The renderer treats values as ordinal rather than as metres. It retains them as
64-bit values until each compatible render-buffer arena rank-compresses them,
and retains first-emitted order through bounded same-rank tie buckets. It sends
only a tiny clip-space depth bias to the GPU. The shader applies the bias after
projection as `bias * clip.w`, so its effect does not grow or shrink with camera
distance. Shared arenas recompute the ranks after tile contributions are
merged, which keeps overlapping features from adjacent render blocks in the
same order. Values in unrelated primitive/depth/billboard buckets do not
establish a global scene graph; the normal Deck layer order remains the outer
ordering boundary.

NDS.Classic sources expose `properties.effectiveRenderOrder` on every eligible
BMD and Routing feature. Classicsource resolves predecessor inheritance from
the sparse `DRAWING_ORDER`, then adds a bounded fractional tie-breaker for
family and physical source-list order. Styles can therefore consume the value
directly; the original flexible Attribute remains available for inspection.

NDS.Live Display2D conversion likewise exposes
`properties.effectiveRenderOrder`. It starts with the type-specific default
from `Display2DLayerMetadata`, then applies `DRAWING_ORDER` and `Z_LEVEL`.
When one DisplayLine has different effective orders along its length, the
converter emits disjoint `DisplayRenderOrder/EFFECTIVE_RENDER_ORDER`
attributes with validity geometry instead of publishing one misleading
feature-wide value. Such ranges are styled with `scope: attribute` and
`attribute-validity-geom: required`; lines with a uniform order use the direct
feature property.

Omitting both fields leaves Deck's stock depth behavior untouched. Use the Z
component of `offset` only for a real geometric displacement; do not use it to
resolve z-fighting. The initial implementation covers points, paths, arrows,
polygons, mapget meshes/AABBs, and labels. GLTF nodes retain their physical
transform and do not consume `z-index` yet.

`glow` adds a shadow or halo to emitted vector geometry without changing its
authored color or width:

```yaml
glow: {color: black, radius: 5, opacity: 0.28}
```

`radius` is required and measured in screen pixels (`0..12`); `color` defaults
to black and `opacity` defaults to one. The material is intentionally literal
in the first version. It applies to paths (including their generated
arrowheads), points, polygons, meshes, and AABBs through the shared GPU mask
compositor. Labels, arbitrary style icons, and GLTF attachments do not yet
participate. One union identity per material removes internal overlaps,
triangle seams, and render-block seams. Unlike an interaction halo, authored
glow is strictly exterior and can never darken the primitive's own fill.

## Interaction effects

Routine feature hover and selection use a constrained, style-owned material
instead of another server filter when the picked typed entry is already
rendered:

```yaml
interaction-effects:
  hover:
    tint: yellow
    tint-mix: 1
    edge-width: 1
    halo: {color: black, radius: 5, opacity: 0.22}
    stripe:
      spacing: 24
      width: 12
      opacity: 0.02
      angle: 45
      offset: 0
      softness: 0.9
  selection:
    tint: {option: selectableFeatureHighlightColor}
    tint-mix: 1
    edge-width: 2
    halo: {color: black, radius: 6, opacity: 0.28}
    stripe: {spacing: 24, width: 12, opacity: 0.05, angle: 45, offset: 0, softness: 0.9}
```

`tint`, `halo.color`, and optional `stripe.color` accept a literal color or
`{option: id}`. A stripe without a color uses the tint. Numeric values must be
finite; mix and opacity are in `[0, 1]`, while widths, radius, and spacing are
non-negative. `stripe.spacing`, `stripe.width` (the visible stripe thickness),
and `stripe.softness` are screen pixels;
`stripe.angle` is the visible clockwise direction in screen degrees;
`stripe.offset` shifts the repeating pattern along its perpendicular axis; and
`stripe.softness` controls its edge transition. Stripe spacing remains in
screen pixels, but its phase is pinned to a projected world anchor so panning
does not slide the pattern across the selected geometry. Effects alter only
material already emitted for a feature, validity, relation, or group. They do
not select geometry, evaluate SIMFIL, or traverse relations.

Existing `mode: hover|selection` rules remain the semantic materializer for
data absent from active subsets—for example an attribute-panel validity or a
recursive topology request. That exact-root `/filter` result is already an
interaction visualization and is rendered exactly as authored; it is not fed
back into `interaction-effects` a second time.
Bundled routine feature-highlight rules are therefore unnecessary, while
attribute and relation highlight rules remain expressive fallbacks.
Selection dominates hover for the same inspection target and for a direct
parent/child target pair (feature/attribute/validity); sibling attribute or
relation targets remain independently hoverable.

Paths, points, polygons, and mapget meshes all enter one view-owned identity
mask system and one shader compositor. Both interaction materials and the
rule-level `glow` field reuse it. Three full-resolution Gaussian fields are
derived from it: union coverage, a semantic edge field sized only by
`edge-width`, and an independent semantic halo field sized only by
`halo.radius`. The same edge contour is used at the outer silhouette and at a
boundary between nested selected objects, so enabling or widening a halo
cannot thicken or soften the tint edge. The shader classifies shape locally,
not by primitive tag: a narrow object has no stable interior and is tinted
solid, while a wide line or area keeps its authored core and receives the edge
and subtle hatch. The behavior therefore changes continuously with on-screen
width and zoom.

Stable semantic-feature mask IDs suppress triangle and render-block seams;
adjacent distinct objects retain a semantic identity boundary and a closed
mesh naturally produces its screen-space silhouette. The fields are bounded
to 12 screen pixels and evaluated only while an interaction or authored glow
group is active.
The halo field is spatially excluded from the crisp edge core. The compositor
emits only tint, stripe, and halo deltas over the
already-rendered map; it never redraws an area's authored fill. No CPU edge
extraction, duplicated widened path, or wireframe fallback is involved. GLTF
nodes initially retain their separate flat-tint/opacity path.
This constrained material contract intentionally does not synthesize missing
geometry or emulate arbitrary style rules.

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

### Layer presets

A style sheet can package a partial Boolean option combination for every layer matched by its existing `layer` affinity:

```yaml
presets:
  - id: lane-topology
    name: Lane Topology
    values:
      - {optionId: showCenterLines, value: true}
      - {optionId: showDigitizationDir, value: true}
```

Preset IDs and names are unique within the style sheet. Every `optionId` must identify an editable Boolean option in that same sheet; `styleId`, a second layer affinity, cross-style values, and enable flags are not accepted. Invalid entries are skipped as style warnings while valid sibling presets and rendering rules remain usable.

`FeatureLayerStyle` parses `options` and `presets` in the same native YAML pass and exposes both through the generated WASM bindings. This keeps source locations, validation reports, imports, edits, and style replacement on one parser lifecycle instead of reparsing preset metadata in TypeScript.

The Maps panel shows eligible embedded presets in each layer's dropdown. Expand a selected preset to edit its Boolean options directly. During hydration and after a complete option/synchronization transaction, the panel selects the unique most-specific preset matching the resulting values; an equal-specificity ambiguity retains the current matching preset, otherwise it becomes **Custom options** without discarding the edited values. Explicitly choosing **Custom options** remains Custom until the next real option edit in the current session, and explicitly choosing a named preset is not replaced during its own apply transaction. Layer preset definitions still have no separate management form: edit them only as part of the complete style YAML. The **Map Presets** tab manages higher-level compositions that refer to these style-owned layer-preset definitions. A map-level selector likewise infers a preset during hydration only when exactly one available composition matches the hydrated layer values.

A map preset applies the subset of its component layers present on the current
map; at least one component must resolve. A reference to a preset that is
missing from an existing component layer rejects the composition for that map.
Equivalent partial compositions are shown only once. Selecting a map preset
never filters unrelated layers or options from the Maps panel.

The road example below shows a map-level preset selector together with the
embedded **Surface Colors** layer preset and its expanded Boolean option:

![Road layer and map-level presets](screenshots/05a-road-and-map-presets.png)

Grid building and intersection layers expose their own preset families:

![Grid building and intersection presets](screenshots/05b-grid-building-intersection-presets.png)

The generic geometry sheet offers separate presets for lines, points, surfaces,
and all geometry together:

![Generic geometry preset selector with All Geometry active](screenshots/05c-generic-geometry-presets.png)

Datasource-specific style sheets expose named combinations through the same
layer preset control. The examples below show named selections and their
rendered states for existing datasource layers.

![NDS.Live Lane Cinematic and Lane Topology presets in split view](screenshots/31a-live-lanes-cinematic-topology.png)

![NDS.Live Display 2D Features and 3D Boxes presets in split view](screenshots/33-live-display-2d-3d.png)

![NDS.Classic BMD layer with the All preset selected](screenshots/34-classic-bmd-all-features.png)

The BMD frame uses the repository's minimal anonymized Classic fixture. It
documents the **All** preset and semantic rule family, not the visual
density of a production map.

![NDS.Classic Lane Group Topology and Routing Travel Direction presets in split view](screenshots/35a-classic-lane-routing-topology.png)

Changing an option reconciles the selector to the unique preset matching the
new values. These two frames keep the camera and panel geometry fixed while
switching from **Surface Colors** to **Uniform Roads**:

![Road preset with surface colors](screenshots/06a-road-preset-surface.png)

![Road preset reconciled to uniform roads](screenshots/06b-road-preset-uniform.png)

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

Feature-transition validities additionally preserve their from/to feature
IDs, connected ends, and a pivot index. Their one line contains the real
incoming ten-metre road slice, an explicit intersection pivot, and the real
outgoing ten-metre slice. A genuinely shorter complete road is extended only
along its outer endpoint tangent. The renderer allocates stack slots per
`(rule, road ID, connected end, canonical physical side)`. It derives the
visible side from the incoming/outgoing headings, converts it through each
connected end, reserves each leg independently, and joins the resulting
distances with a tangent-continuous variable-offset fillet while retaining one
pick identity and terminal arrow. Returning to the same connected end of the
same road uses the compact left-side U-turn hairpin described above;
opposite-heading cross-road legs retain the ordinary fillet.

## Relation rules

```yaml
- type: LaneGroup
  scope: relation
  mode: [hover, selection]
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
- `relation-line-geometry`: `centers` (default) or `connection-stubs`; the
  latter draws a short directed segment through the
  physical connection from relation and feature geometry already available to
  the subset renderer, then preserves a minimum projected size for overview
  zooms. If both selected endpoints are coincident point geometries and neither
  feature provides a line tangent, it draws a screen-facing ring around the
  connection because no direction can be derived;
- `relation-line-end-markers`;
- `relation-source-style`;
- `relation-target-style`.

Relation expressions can use the relation root plus `$source`, `$target`, and
`$twoway`. Endpoint styles may independently select semantic geometry.
`RelationEntry` carries source/target feature entries and explicit source and
target geometry collections.

Use a mode list when hover and selection intentionally share identical
relation geometry. The planner emits the same authored channel independently
for each interaction pass. Interaction planning admits a relation channel only
for an exact relation-row target and adds that row's restriction; selecting its
host feature does not activate sibling relation rules. If that exact target is
already present in a regular or search presentation, the local interaction
compositor highlights it instead. Authored relation geometry is requested only
as a fallback while the target is absent, and this choice is reconciled again
when style changes materialize or remove regular geometry.

Generic bidirectional display uses permanent south-west ownership. If that
owner is outside current coverage, the pair is not rendered. Selection
traversal is root-owned.

## Level of detail

Each style uses an integer level of detail (LOD) from 0 through 7. LOD 0 is the
coarsest presentation for a dense viewport; LOD 7 is the most detailed. The
visible tile count at the layer's tile level determines the current LOD. It is
a presentation decision and does not change mapget geometry names or source
data semantics.

By default, the **LOD 3 Tile Threshold** preference supplies a boundary `T`
between LOD 2 and LOD 3. Its default is 128 visible tiles. The seven descending
boundaries for LOD 0 through 6 are derived as
`[4T, 2T, T, T/2, T/4, T/8, T/16]`; a count below the last boundary selects
LOD 7. A stylesheet can replace those boundaries with exactly seven strictly
descending positive counts:

```yaml
lod-thresholds: [512, 256, 128, 64, 32, 16, 8]
```

Use `lod-range` on a top-level rule when the complete rule, including its
backend filter channel, should exist only within part of the ladder:

```yaml
- type: Road
  lod-range: [0, 3]
  geometry: line
  geometry-name: centerline
```

Crossing a boundary which changes the active rule set replaces the affected
filter plan. Moving between adjacent LODs with the same rule set keeps the
existing subset and only updates presentation state.

Use `min-lod-expression` when individual emitted entries should disappear as
the viewport gets denser without replacing the filter plan or rerendering the
tile. The expression is projected with the rule's other fields, rounded up,
and clamped to 0 through 7. The GPU draws the entry only while the current LOD
is at least that minimum:

```yaml
- type: Road
  geometry: line
  min-lod-expression: attributes.minimumDisplayLod
```

Explicit hover and selection masks remain visible even when the corresponding
base entry is hidden by `min-lod-expression`.

`fidelity` is parser shorthand only: `low`, `high`, and `any` become
`lod-range: [0, 2]`, `[3, 7]`, and `[0, 7]`, respectively. There is no separate
low/high-fidelity render pass.

## Validation and planner failures

Style validation reports source rule index, property, message, and YAML
location. Important hard failures include:

- schema version other than 2;
- removed `aspect`, `stage`, or `lod`;
- malformed `lod-thresholds` or `lod-range` declarations;
- combining `fidelity` with `lod-range`, or putting either gate on a nested rule;
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

Presentation choices such as highlight mode, active LOD rule plan, options, style
identity/order, and rule tree participate in the render signature. Backend
transport identity is only `filterId + generation + output tile`.

Deck picks store `(channel ordinal, typed-entry ordinal)` against the exact
subset retained by the visualization. Nested render-rule and primitive details
stay renderer-local.
