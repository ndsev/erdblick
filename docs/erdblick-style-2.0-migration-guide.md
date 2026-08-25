# Erdblick Style 2.0 Migration Guide

This guide is for style sheets written for erdblick/MapViewer 2026.3.1. It
explains the changes required by style schema 2 and the newer presentation
features which are worth adopting while a style is being migrated.

For the complete current field reference, see the
[Style System Guide](erdblick-stylesystem.md). This page is intentionally
version-specific: it describes the migration from the 2026.3.1 contract rather
than repeating every current style field.

## Why this is a breaking migration

MapViewer 2026.3.1 styles used `version: 1.0` and were evaluated against staged
feature tiles. Current mapget streams no longer contain tile load stages or a
feature LOD value. Geometry stage numbers have also been replaced by
layer-local semantic geometry names.

Style schema 2 follows that model directly:

- `version: 2` is mandatory;
- numeric `stage` fields are gone;
- the old per-feature scalar `lod` field is gone;
- `geometry-name` selects semantic geometry;
- stylesheet LOD 0 through 7 controls presentation density, not source data;
- style rules are planned into mapget `/filter` channels and rendered from the
  resulting projected subsets.

There is deliberately no version-1 compatibility mode. A numeric stage cannot
be translated reliably without knowing what that stage meant for a particular
layer, and the old feature LOD no longer exists in the mapget model.

## Migration at a glance

| 2026.3.1 style | Style schema 2 | Required action |
|---|---|---|
| `version: 1.0` | `version: 2` | Change the root version to the integer `2`. |
| Root `stage` | Removed | Delete it and express data/geometry requirements in the rules. |
| Rule `aspect` | `scope` | Rename it; keep `feature`, `attribute`, or `relation`. |
| Rule `stage` | `geometry-name` | Replace the number with the source's semantic geometry name. |
| Rule `lod` | Removed | Redesign using data fields, `lod-range`, or `min-lod-expression`, depending on the original intent. |
| `fidelity` as low/high geometry selection | LOD shorthand | Review every occurrence; it now means only `[0, 2]` or `[3, 7]` presentation LOD. |
| `label-font` | Split fields | Use `label-font-family`, `label-font-weight`, and `label-size`. |
| `label-horizontal-origin` | `label-text-anchor` | Translate to Deck text anchoring. |
| `label-vertical-origin` | `label-alignment-baseline` | Translate to Deck baseline alignment. |
| `label-style` | Outline fields | Use `label-outline-color` and `label-outline-width`, or omit both for fill only. |
| `label-scale` | `label-size-scale` | Rename and retune if necessary. |
| `label-eye-offset` | Removed | Use `label-pixel-offset` or physical `offset`. |
| `label-height-reference` | Removed | Use physical `offset` when displacement is actually required. |

The existing root `name`, `layer`, `default`, `options`, and `rules` concepts
remain. Common presentation fields such as `color`, `opacity`, `width`,
`outline-color`, `outline-width`, `offset`, `offset-increment`, `depth-test`,
and `flat` also remain available.

## Start with a valid schema-2 document

Use an integer version, not `2.0`:

```yaml
name: Example/Roads
layer: Road
version: 2
default: true

options:
  - id: showRoads
    label: Show roads
    type: bool
    default: true

rules:
  - type: Road
    filter: showRoads
    geometry: [line]
    geometry-name: centerline
    color: "#d6a879"
    width: 3
```

`category` is optional. It defaults to `base`; use `category: search` only for
a reusable search-result style. Option types remain `bool`, `color`, and
`string`.

## Replace stages with semantic geometry

### Root `stage`

In 2026.3.1, root `stage` delayed the complete style until the tile reached a
numeric load stage. There is no equivalent gate in schema 2. Remove it.

The current planner derives the geometry and projected fields required by each
rule. Make those requirements explicit with `scope`, `filter`,
`attribute-filter`, `geometry`, `geometry-name`, and expression fields. If a
target layer cannot satisfy a rule, the style planner reports the problem for
that layer instead of waiting for a numeric stage.

Do not replace root `stage` with `lod-range`: style LOD is a viewport-density
decision and does not describe data readiness.

### Rule `stage`

In 2026.3.1, a rule-level stage selected geometry with an exact numeric stage.
Replace it with the semantic name published by the layer:

```yaml
# 2026.3.1
- type: Lane
  fidelity: high
  stage: 0
  geometry: [line]
  color: "#57a2f9"
```

```yaml
# Schema 2
- type: Lane
  lod-range: [3, 7]
  geometry: [line]
  geometry-name: centerline
  color: "#57a2f9"
```

The `lod-range` in this example preserves only the old rule's detailed-view
gate. It is independent of `geometry-name` and should be omitted when the
centerline belongs in every density band.

Likewise, an NDS.Live rule which used `stage: 2` specifically for ADAS
geometry should normally use the semantic name:

```yaml
- type: Lane
  geometry: [line]
  geometry-name: ADAS
  color: "#25d4c8"
```

Geometry names are exact, case-sensitive, and local to the layer. Typical
names include `centerline`, `surface`, `position`, `reference`, and `ADAS`, but
do not assume those names for a custom datasource. Inspect the layer's feature
model, geometry entries in inspection/GeoJSON, or a current bundled style for
that layer.

`geometry` still selects the shape kind. `geometry-name` selects its logical
role. Omitting `geometry-name`, or using `*`, accepts every semantic name of a
matching shape kind. Be explicit when a feature contains several line or
surface geometries; a wildcard can intentionally render more than one of
them.

## Rename `aspect` to `scope`

The values are unchanged, but `scope` belongs to the top-level rule:

```yaml
# 2026.3.1
- type: Road
  aspect: attribute
  attribute-layer-type: Guidance
  attribute-type: SPEED_LIMIT
  geometry: [line]
```

```yaml
# Schema 2
- type: Road
  scope: attribute
  attribute-layer-type: Guidance
  attribute-type: SPEED_LIMIT
  geometry: [line]
  geometry-name: centerline
```

The available scopes are:

| Scope | Entry evaluated and rendered |
|---|---|
| `feature` | The feature itself. This is the default. |
| `attribute` | Matching attribute entries and their effective validity geometry. |
| `relation` | Matching relation entries and their source/target geometry. |

For attribute rules, `filter` applies to the host feature and
`attribute-filter` applies to the expanded attribute entry. Nested
`first-of`/`all-of` branches inherit their top-level scope and may not change
it. Split an old tree into separate top-level rules if its descendants changed
aspect.

A top-level relation rule may not contain `first-of` or `all-of`. Put branches
inside `relation-source-style` or `relation-target-style`, or split genuinely
different relation presentations into separate top-level rules.

## Redesign old LOD and fidelity rules

### The two LOD concepts are not equivalent

The 2026.3.1 scalar `lod` matched `Feature::lod()` in the old mapget model.
That value no longer exists. Schema-2 LOD is instead an erdblick presentation
ladder derived from the number of visible tiles:

- LOD 0 is the coarsest presentation for the densest viewport;
- LOD 7 is the most detailed presentation for the smallest viewport;
- it is independent of the map layer's tile level/Z;
- it does not select a backend geometry stage.

Therefore this old rule has no mechanical translation:

```yaml
- type: Road
  lod: 4
  geometry: [line]
```

If `lod: 4` represented a real source classification, filter on the current
source field which carries that classification. If it represented display
priority, use the new presentation LOD fields.

### Gate a complete rule with `lod-range`

Use an inclusive `lod-range` when the whole rule and its backend filter channel
should exist only for part of the density ladder:

```yaml
- type: Road
  lod-range: [3, 7]
  geometry: [line]
  geometry-name: centerline
```

`lod-range` is allowed only on a top-level rule. Crossing a boundary which
changes the active rule set replaces the affected filter plan, so avoid
creating many bands when only individual feature visibility changes.

### Use `min-lod-expression` for per-entry detail

Use one broad rule plus `min-lod-expression` when different features should
appear progressively:

```yaml
- type: Road
  geometry: [line]
  geometry-name: centerline
  min-lod-expression: properties.minimumDisplayLod
  color: "#d6a879"
  width: 3
```

The expression is evaluated per emitted entry, rounded up, and clamped to 0
through 7. Retained geometry fades smoothly across the continuous interval
before its minimum integer LOD, without replacing the filter plan or
rerendering the tile. This is preferable to one top-level rule per road class
when color and geometry otherwise stay the same.

### Configure the density ladder when necessary

The root can define the seven descending visible-tile boundaries between the
eight LOD values:

```yaml
lod-thresholds: [128000, 64000, 16000, 2048, 256, 128, 32]
```

The list must contain exactly seven strictly descending positive integers.
Without it, erdblick derives the boundaries from the user's **LOD 3 Tile
Threshold** setting `T` as `[4T, 2T, T, T/2, T/4, T/8, T/16]`.

### Treat `fidelity` as shorthand only

The field is still accepted, but its meaning changed:

| Schema-2 value | Equivalent range |
|---|---|
| `fidelity: low` | `lod-range: [0, 2]` |
| `fidelity: high` | `lod-range: [3, 7]` |
| `fidelity: any` | `lod-range: [0, 7]` |

There is no separate low/high-fidelity render pass. `fidelity` and
`lod-range` cannot appear together. Review every old fidelity declaration:

- use `geometry-name` when the intent was to select low- or high-fidelity
  geometry;
- use `lod-range` when the intent was to change presentation with viewport
  density;
- omit both when the same semantic geometry should render throughout the
  ladder.

## Migrate labels to Deck text fields

Schema 2 exposes Deck `TextLayer` concepts directly. The old Cesium-shaped
fields are rejected rather than approximated.

| 2026.3.1 field/value | Schema-2 replacement |
|---|---|
| `label-font: "800 18px Helvetica"` | `label-font-weight: 800`, `label-size: 18`, `label-font-family: Helvetica` |
| `label-horizontal-origin: LEFT` | `label-text-anchor: start` |
| `label-horizontal-origin: CENTER` | `label-text-anchor: middle` |
| `label-horizontal-origin: RIGHT` | `label-text-anchor: end` |
| `label-vertical-origin: ABOVE` | Usually `label-alignment-baseline: bottom` |
| `label-vertical-origin: CENTER` | `label-alignment-baseline: center` |
| `label-style: FILL` | Omit outline fields. |
| Fill plus outline | Set `label-outline-color` and `label-outline-width`. |
| `label-scale` | `label-size-scale` |
| `label-eye-offset` | `label-pixel-offset` or physical `offset` |

Translate origins by visual intent if an old style used a less common value.
The anchor describes which part of the text box is attached to the geometry.

For example:

```yaml
# 2026.3.1
label-text-expression: displayName
label-font: "800 18px Helvetica"
label-style: FILL
label-color: white
label-horizontal-origin: LEFT
label-vertical-origin: ABOVE
label-background-color: black
label-background-padding: [4, 4]
```

```yaml
# Schema 2
label-text-expression: displayName
label-font-family: Helvetica
label-font-weight: 800
label-size: 18
label-color: white
label-text-anchor: start
label-alignment-baseline: bottom
label-background: true
label-background-color: black
label-background-padding: [4, 4]
```

Unlike the old behavior, `label-background-color` alone does not enable a
background rectangle. Add `label-background: true`.
Deck interprets `label-outline-width` relative to text size, so visually
compare and retune any retained outline width instead of assuming an old value
has the same apparent thickness.

Useful new text controls include:

- `label-size-units`, `label-size-min-pixels`, and
  `label-size-max-pixels`;
- `label-angle` and `label-opacity`;
- `label-background-border-radius`, `label-border-color`, and
  `label-border-width`;
- `label-line-height`, `label-word-break`, and `label-max-width`;
- `label-collision: true` and `label-collision-priority` for optional
  overlap filtering.

Labels are rendered in a final text overlay. Map geometry and contact shading
do not obscure or post-process them. `depth-test` only affects ordering among
labels in that overlay.

## Audit rules which may still parse but render differently

### Path width and `billboard`

Paths now extrude in the map plane by default. Add `billboard: true` when a
line should retain a constant screen-facing width under camera tilt:

```yaml
- geometry: [line]
  geometry-name: centerline
  billboard: true
  width: 3
```

Do this deliberately. Map-plane strokes are preferable for physical road
surfaces and casings; billboard strokes are often preferable for diagnostics,
markings, topology, and highlights.

### Label backgrounds

As noted above, add `label-background: true` if an old style relied on
`label-background-color` implicitly enabling the rectangle.

### Z offsets used only for stacking

Keep the Z component of `offset` only when the geometry is physically displaced.
Replace small positive offsets or long `offset-increment` ladders which exist
only to suppress z-fighting with the ordinal z-index fields described below.

### Hover and selection rules

`mode: hover` and `mode: selection` remain valid, but routine highlighting of
already-rendered feature geometry can now use one root `interaction-effects`
material. Keep explicit mode rules when they materialize geometry which is not
otherwise present, such as an attribute validity, recursive topology, or
relation endpoint.

When hover and selection intentionally use the same semantic rule, `mode` may
be a list:

```yaml
mode: [hover, selection]
```

### Server-side planning

Each applicable top-level rule becomes one ordered mapget `/filter` channel.
The planner projects only the fields needed by that rule tree. Existing SIMFIL
expressions usually remain valid, but they are now schema-compiled against each
target map layer and failures are reported with their source rule and YAML
location.

Prefer one top-level rule with `first-of` or `all-of` branches when the
branches share semantic input. Prefer `color-scale`, `width-scale`, and
`min-lod-expression` when only one scalar presentation value changes. This
reduces backend channels and duplicate projected fields.

Point grouping is now planned server-side. A grouped rule must remain
feature-scoped and point-only, and every concrete leaf must use a compatible
`point-merge-grid-cell` and geometry name. The planner rejects incompatible
trees instead of producing a misleading `$mergeCount`.

## Capabilities to adopt during migration

The following additions are not required for schema-2 validity, but they solve
common patterns which previously required many branches or fragile rendering
hacks.

### Typed color and width scales

Use scales instead of palette-only `first-of` trees:

```yaml
- type: Road
  geometry: [line]
  geometry-name: centerline
  color-scale:
    mode: categorical
    expression: properties.roadClass
    stops:
      - [0, "#d98262"]
      - [1, "#e9aa75"]
      - [2, "#f1c58f"]
    fallback: "#d9c7ae"
  width: 1
  width-scale:
    mode: categorical
    expression: properties.roadClass
    stops:
      - [0, 7]
      - [1, 5]
      - [2, 3]
    fallback: 1
```

Categorical stops use exact typed equality. Linear scales interpolate between
strictly increasing numeric stops. A scale stop is always a `[value, result]`
pair, not a YAML map. `color`, `color-expression`, and `color-scale` are
mutually exclusive.

Use identical expression text for color and width when they depend on the same
field. The planner can then reuse one projected value.

### Ordinal z-index

Use `z-index` for authored ordering and `z-index-expression` for data-driven
ordering:

```yaml
- type: BMD_Area
  geometry: [polygon, mesh]
  z-index: 100
  z-index-expression: properties.effectiveRenderOrder
```

The literal is the fallback when the expression does not return a finite
number. Fractional values are supported; only their order matters. Higher
values render in front without moving geometry in world space, so the effect
does not grow with zoom or camera pitch.

NDS.Classic BMD and Routing features expose
`properties.effectiveRenderOrder` where the datasource can derive it. NDS.Live
Display2D uses the same property for a uniform feature order and can expose
varying ranges as `DisplayRenderOrder/EFFECTIVE_RENDER_ORDER` attributes.

Do not assume z-index creates one global order across unrelated primitive,
depth, and billboard buckets. Avoid relying on equal-value tie order when an
explicit distinction matters. GLTF nodes currently keep their physical
transform and do not consume z-index.

For a surface and its own coplanar overlay, schema 2 also supports semantic
support ownership. Configure both fields as a pair on both rules:

```yaml
# Supporting lane-group surface
z-index-group-expression: laneGroupId
z-index-role: support
```

```yaml
# Centerline or marking belonging to that surface
z-index-group-expression: properties.laneGroupId
z-index-role: overlay
```

The renderer first resolves the physically nearest support group at each
pixel, then retains only an overlay with the same group. This is useful for
stacked lane groups, where an upper group's markings must not bleed through a
lower or hidden surface. `z-index-role` accepts only `support` or `overlay` and
is invalid without `z-index-group-expression`.

### Polygon extrusion and surface shading

Extrude polygons or triangle-mesh boundaries in metres:

```yaml
- geometry: [polygon, mesh]
  polygon-height: 3
  polygon-height-expression: attributes.layer.BMD.BUILDING_HEIGHT.buildingHeight
  surface-shading: true
```

The expression is evaluated per entry and falls back to the literal height.
Values must be finite and non-negative. Erdblick raises the roof and generates
walls for boundary rings while suppressing internal mesh diagonals.

`surface-shading: true` adds restrained ambient/directional shading in 3D. It
does not cast shadows or change alpha, and 2D rendering keeps the authored
color.

### Interaction effects and glow

Replace duplicated generic hover/selection rules with one root material when
the base geometry is already rendered:

```yaml
interaction-effects:
  hover:
    tint: yellow
    tint-mix: 1
    edge-width: 1
    halo: {color: black, radius: 5, opacity: 0.22}
  selection:
    tint: "#55a7ff"
    tint-mix: 1
    edge-width: 2
    halo: {color: black, radius: 6, opacity: 0.28}
    stripe: {spacing: 24, width: 12, opacity: 0.05, angle: 45}
```

Interaction effects alter emitted material only. They do not request missing
geometry, evaluate a new SIMFIL rule, or traverse relations. That is why
semantic `mode` rules still matter for validity and relation visualization.

Use rule-level `glow` for a persistent authored halo or shadow:

```yaml
glow: {color: black, radius: 4, opacity: 0.3}
```

Glow applies to vector points, paths, arrows, polygons, mapget meshes, and
AABBs. It does not currently apply to labels, arbitrary icons, or GLTF nodes.

### Explicit dash and offset units

Schema 2 adds independent dash length/gap and unit controls:

```yaml
dashed: true
dash-length: 3
dash-gap: 6
dash-unit: pixels
```

Omitting `dash-gap` preserves the old cadence by using `dash-length` for both
parts. `dash-unit` accepts `meter`, `meters`, `m`, `pixel`, `pixels`, or `px`
and defaults to pixels.

`lateral-offset-unit` similarly controls the first component of `offset` and
`offset-increment`:

```yaml
offset: [3, 0, 0]
lateral-offset-unit: meters
```

The remaining offset components stay in world space.

### Layer presets

Package useful combinations of a style's Boolean options with the style:

```yaml
presets:
  - id: topology
    name: Topology
    values:
      - {optionId: showCenterLines, value: true}
      - {optionId: showBoundaries, value: true}
      - {optionId: showTopology, value: true}
```

Each `optionId` must refer to an editable `type: bool` option in the same
sheet. Layer presets are partial option combinations; they do not contain a
second layer affinity or another style ID.

Map-level presets are separate MapViewer configuration. They compose these
style-owned layer presets across the layers present in a map.

### Relation connection geometry

Existing relation fields remain, with `scope: relation` replacing `aspect`.
Use the optional relation line selector when center-to-center lines are too
abstract:

```yaml
scope: relation
relation-line-geometry: connection-stubs
```

`centers` remains the default. `connection-stubs` derives a short directed
segment from relation and endpoint geometry already present in the subset.

### Saved search styles

Reusable Feature Search presentation can be stored as an ordinary style sheet
with:

```yaml
category: search
version: 2
```

The category is metadata. The saved style contains presentation rules and an
option gate, not the original search query, selected map, or result session.
Regular project styles should remain `category: base` or omit the field.

## Expression and path compatibility

Most existing SIMFIL property expressions remain source-compatible. Mapget
also exposes `attributes` as an alias for a feature's top-level `properties`
field. Existing `properties...` expressions do not need a mechanical rewrite;
use whichever spelling makes the style consistent with its datasource and
the current inspection/search paths.

Attribute and relation expression contexts are richer than ordinary feature
context. Attribute rules can use `$feature`, `$layer`, `$name`,
`$attributeIndex`, `$hasValidity`, `$validityIndex`, and `$validityCount`.
Relation rules can use `$source`, `$target`, and `$twoway`.

## Recommended migration workflow

1. Work on one style sheet at a time and change its root to `version: 2`.
2. Remove root `stage`, then replace every rule `stage` with a verified
   `geometry-name`.
3. Rename `aspect` to top-level `scope` and split mixed-scope trees.
4. Redesign every scalar `lod` and review every `fidelity` declaration.
5. Convert all removed label fields and explicitly enable label backgrounds.
6. Open **Edit -> Styles Configurator**, apply the YAML, and resolve every
   stylesheet, rule, planner, and expression diagnostic.
7. Replace z-offset stacking with z-index, and consolidate palette/width rules
   into scales where appropriate.
8. Test each targeted map layer at dense and sparse viewport sizes, in 2D and
   tilted 3D, and with hover/selection active.
9. Test attribute validity and relation rules separately; routine feature
   interaction is not evidence that semantic materialization works.
10. Remove or reset browser-stored modified copies which would otherwise mask
    the updated source file.

In an integrated MapViewer checkout, product style sources belong in the
top-level `config/styles/` directory, not `deps/erdblick/config/styles/`.
Current source builds can expose that directory at `/static-config` and offer
**Save to Source** in the editor. Editing an existing source-backed YAML file
requires neither a CMake reconfigure nor an Angular rebuild. See
[MapViewer source-style editing](erdblick-setup.md#mapviewer-source-style-editing)
for the hosting requirements.

## Final compatibility checklist

- The root says `version: 2`, as an integer.
- No root or rule contains `stage`.
- No rule contains `aspect`, scalar `lod`, or a removed label field.
- Every former numeric geometry stage has a verified semantic
  `geometry-name`.
- Every retained `fidelity` declaration is intentionally a stylesheet LOD
  shorthand.
- `scope`, `lod-range`, and `fidelity` occur only on top-level rules.
- Attribute host filters and entry filters use `filter` and
  `attribute-filter` deliberately.
- Label fonts are split into family, weight, and size; backgrounds are
  explicitly enabled.
- Physical displacement uses `offset`; authored overlap order uses z-index.
- Screen-facing path widths explicitly set `billboard: true`.
- Repeated color/width branches have been considered for typed scales.
- Per-entry density filtering has been considered for
  `min-lod-expression` rather than many LOD channels.
- The style has been validated against every intended layer schema, not only
  parsed in isolation.
