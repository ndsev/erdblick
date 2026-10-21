# Service-owned application state

Domain services own durable values and the operations that change them.
`AppStateService` registers those values and coordinates publication, local storage,
config ownership, snapshots and URL persistence. It has no camera, layer,
inspection, search or preference methods. Ordinary application code calls owners
and reads typed values. String-based dispatch is confined to external actions and
the omnibar.

## A stored value and its consumer

`CoordinatesService` declares the marker beside its marker operations:

```ts
readonly markerState = this.stateService.registerState<boolean>({
    name: 'marker',
    defaultValue: false,
    schema: Boolish,
    urlParamName: 'm',
    urlIncludeInVisualizationOnly: false
});
```

The storage key and URL name remain compatible with existing installations.
`setMarker()` changes position and visibility together in a transaction. Consumers
use `coordinates.markerState.subscribe(...)` for that one value, or a completed
projection when they need both values:

```ts
persistence.observe(() => coordinates.markerControlValue).subscribe(marker => {
    // Position and visibility belong to the same completed edit.
    updateMarkerOverlay(marker);
});
```

`updateMarkerOverlay` represents the consumer's rendering work; the state registry
does not provide rendering behavior.

## Controls and actions

A control is an explicit public reader/writer. It is independent of how many
internal values implement it. For example,
[`coordinates.service.declarations.ts`](../app/coords/coordinates.service.declarations.ts)
names `coordinateControls.marker` and keeps its selector and WGS84 value schemas
inline. Its owner registers the ordinary method directly:

```ts
actions.registerControl(coordinateControls.marker, {
    read: () => this.markerControlValue,
    write: (_selector, value) => this.setMarker(value)
});
```

`ConnectionPreferencesService` exposes transport compression through the separate
`app.preferences.connection` control; `app.preferences.rendering` covers graphics
quality, tile budget and worker count.

Actions use the same small registration surface. The inspection owner binds its
close operation and supplies live omnibar choices:

```ts
actions.registerAction(inspectionStateActions.closeInspection, input => {
    this.closeInspection(input.panelId, input.lifetime);
    return applied();
}, query => this.closeInspectionCandidates(query));
```

A candidate contains a recognizable name such as `Close Road.17`, presentation
metadata, and typed arguments. Both MCP and the omnibar invoke that registration.
The close handler checks the captured panel lifetime; closed/replaced panels cannot
be targeted through stale choices. `app.selections` supplies panel IDs and lifetime
tokens to MCP clients.

The six coordinate/tile parsers, feature search, source-data inspection, feature
jumps, configured jump providers, asynchronous location results and external
viewers also register candidates with their owners. Local-only actions declare
`exposure: "omnibar"`. They use the same argument validation and dispatch while
remaining absent from the public tool artifact. Feature/plugin execution returns
its promise so failures reach the caller. History resolves a fresh live candidate;
explicit saved view scopes use logical IDs. An ordinary coordinate replay still
means “navigate the currently focused map.”

## Ownership and initialization

The [storage inventory](#stored-state-inventory) lists every deployed key.
The initializer explicitly constructs all durable owners, installs
`AppUrlStateService`, and seals persistence registration before config seeding and
hydration. Duplicate or late registration fails. The actual owner fixture checks
the frozen 70-key release inventory plus `viewIds`; adding a new value does not
require another production key list.

| Owner | Responsibilities |
| --- | --- |
| `MapViewStateService` | Ordered view IDs, committed cameras, focus, projection, sync and background/grid preferences |
| `MapViewService` | Renderer lifetimes, camera previews, navigation and view removal/creation orchestration |
| `MapLayerStateService` | Layer settings, style option associations, presets and layer catalog retention |
| `MapInfoService` | Loaded catalog/tree, preset application and coordinated complete-catalog cleanup |
| `InspectionStateService` | Selection, panel identity/lifetime, focus, locks, comparison and layout cleanup |
| `InspectionSelectionService` | Asynchronous feature loading, selection work and feature navigation |
| `FeatureSearchService` | Search definitions, live sessions, target membership and search actions |
| `StyleService` | Style documents, visibility, editor preferences and style operations |

Other preferences remain with coordinates/policy, rendering, connection, layout,
config, diagnostics and location-search owners. Domain models live beside those
owners; `shared/app-state.model.ts` contains only persistence types and utilities.

The dependency path `MapViewService` → `MapInfoService` → `MapLayerStateService` →
`MapViewStateService` has no reverse DI edge. Layer/search owners register explicit
membership callbacks with the durable view owner. Each retains its own values and
invariants. The runtime view owner handles renderer teardown before membership is
changed. Complete catalog cleanup is one system-origin transaction initiated by
`MapInfoService`; layer, style and inspection owners clean their own domains.
Incomplete catalogs cannot erase pending selections/preferences.

The WGS84 text parser is a pure coordinate helper shared by jump and external
viewer owners. External viewers do not depend on jump targets, avoiding the
context-menu dependency cycle. Startup loads config and native bindings, hydrates
persistence, then initializes styles, catalog/transport, jumps, inspection, search
and external adapters in the required order.

## Publication contract

`transaction()` is synchronous. It tracks only touched slots, restores original
references on failure, suppresses net-no-op edits, and retains original references
for equal final values. It does not clone unrelated application state. Pending
writes retain their user, system, hydration or configuration origin; projected
compatibility keys inherit their source's origin.

A slot subscription immediately receives that slot's current value, including a
staged value when subscribed inside an edit. Slot notifications run after explicit
changes are staged. `combineLatest` over separate slots caches their independent
notifications and cannot promise a coherent multi-slot observation. Consumers
needing that guarantee use `AppStateService.observe(() => projection)`, which emits
after slot-derived edits finish. Writes requested by completed observers are
queued until every observer has seen the current commit. A new completed observer
installed during an edit waits for commit or rollback.

Owners batch semantic operations themselves: synchronized camera/projection edits,
presets, membership changes and panel operations work correctly through ordinary
UI callers as well as through the action adapter. Async work captures targets,
awaits outside a transaction, then revalidates lifetime before the synchronous
commit. A transaction does not roll back arbitrary network or renderer effects.

## Identity and compatibility

Ordered `ViewId`s are authoritative membership. The deployed `numberOfViews` key
projects its count, while numeric `focus` encodes an internally stored ID. Cameras,
layers and style options use keyed records with the existing positional storage
and URL codecs. Search references use live IDs and project old selected-view indices
at storage/UI boundaries. Newly created views inherit selection from the requested
source; removed references are pruned. Split proportions remain positional layout.

The deployed scalar codec compacts booleans to `0`/`1`; per-view snapshot and storage
arrays retain booleans. URL CSV encoding compacts both. Public controls expose their
typed boolean values independently of these persistence formats.

Share links carry ordered IDs in `vid`: 1–32 unique IDs, each 1–64 ASCII letters,
digits, underscores or hyphens. Object.prototype property names are reserved.
Repeated/malformed explicit IDs reject before mutation or navigation. If `n` is
supplied it must agree; otherwise the explicit ID list determines the count.
Empty/partial links without IDs keep saved/current membership and resize it once
for the effective count. Full replacement without IDs creates a fresh mapping.

URL and snapshot membership imports run the owning workflow before positional
codecs. Retained IDs keep omitted camera/layer/option values. New import IDs can
inherit omitted positional values for compatibility; removed search associations
are pruned and cannot reappear on ID restoration. Full snapshot replacement resets
omitted snapshot-eligible values; local-only search definitions remain outside
snapshots. Corrupt saved identity/count fields recover individually, preserving
other saved state. Explicit invalid URL/snapshot IDs remain strict errors.

Renderer registrations pair logical IDs with runtime generations. Removing and
restoring a URL ID invalidates captured async work. Reorder preserves logical
camera, layer and option associations. The current PrimeNG splitter recreates
renderer components whenever ordered membership changes, including a reorder;
replacement renderers receive new generations. Async work resolves the current
index only if its captured renderer generation is still live. Feature navigation
without an explicit view still addresses every matching visible view, with
focused fallback.

## Catalog and verification

Owner-named declaration companions keep schemas easy to locate and side effects
out of build collection. Importing Angular owner modules in Node was experimentally
possible; companions are a readability choice, not an SSR limitation. The pure
build collector composes named declarations, rejects duplicate names before
indexing, and exports 32 public actions and 21 controls. Startup verifies exact
registration completeness. Runtime plugins, location results and provider choices
never enter that artifact.

`ViewerActionService` owns relay/admission/cancellation and Angular scheduling.
Mutation permissions derive from action metadata. Reads run outside Angular;
mutations run inside. Public targets use `control` and logical `viewId`. The native
format-version-one manifest retains its `channels` envelope. Map/layer/background/
style/style-option/preset discovery belongs to the corresponding owner.

Run from the erdblick root, with the unchanged native/WASM bindings available:

```sh
NG_BUILD_MAX_WORKERS=2 npm run test -- --watch=false
npm run lint
NG_BUILD_MAX_WORKERS=2 npm run build
npm run generate:viewer-actions
```

The official suite includes publication rollback/reentrancy/origins, actual owner
startup, config/storage/URL compatibility, snapshot membership, asynchronous stale
targets, Angular DI and common action/candidate dispatch. The integration runner
uses the already-built bundle and the selected `MAPGET_BIN`:

```sh
EB_MAPGET_MCP_LOCAL=1 EB_MAPGET_CONFIG=test/mapget-native-grid.yaml \
  npm run test:integration -- --project='' --workers=1 \
  playwright/tests/state-owner-actions.spec.ts playwright/tests/owner-omnibar.spec.ts
```

The tradeoff is explicit coordination: Observable slot streams remain familiar,
but multi-owner consumers must select completed projections, and startup must
construct every owner. Shared positional URL grammar still needs a coordinator.
The registry adds transaction/publication logic and compatibility codecs; it does
not implement selectors, effects, reducer factories or another domain store API.

## Stored-state inventory

Release baseline: `6f5ba2fd6d6cb3810cd9bf4c305e0d5b229f4ef8`. The actual owner startup test in `app/mapview/view-identity.spec.ts` checks every frozen deployed key, including local-only preferences. The `styleOptions` registration retains compact option keys through its explicit storage/config/snapshot paths.

| Owner file | Stored keys |
| --- | --- |
| `app/coords/coordinates-policy.service.ts` | `coordinatesEnabled`, `coordinatesLegalTermsAccepted` |
| `app/coords/coordinates.service.ts` | `marker`, `markedPosition`, `enabledCoordsTileIds` |
| `app/mapview/render-preferences.service.ts` | `deckAntialiasingEnabled`, `semanticCompositingEnabled`, `contactShadingEnabled`, `lod3TileThreshold`, `tileSubsetRenderWorkerCount`, `pointCloudDownsamplingEnabled`, `pointCloudDetailPixels`, `pointCloudWorkingMemoryMiB`, `pointCloudGpuMemoryMiB`, `tilesLoadLimit` |
| `app/mapview/map-view-state.service.ts` | `viewIds`, `numberOfViews`, `focus`, `viewSync`, `cameraView`, `mode2d`, `mapZoomStep`, `featureZoomClearanceMeters`, `background`, `tileBorders`, `tileGridMode`, `tileGridLevel`, `tileGridAutoLevel`, `tileGridColor`, `tileGridOpacity` |
| `app/mapdata/map-layer-state.service.ts` | `layerSyncOptions`, `layerNames`, `visibility`, `zoomLevel`, `autoZoomLevel`, `styleOptions`, `stylePresetSelection`, `mapPresetSelection` |
| `app/mapdata/connection-preferences.service.ts` | `tilePullCompressionEnabled`, `connectionRetryEnabled`, `connectionRetryInitialDelayMs`, `connectionRetryBackoffMultiplier`, `connectionRetryMaxDelayMs` |
| `app/shared/app-layout.service.ts` | `mapsOpenState`, `dockOpenState`, `dockWidth`, `viewPanelSizes`, `dockActiveTabState`, `dockAutoCollapse`, `dialogLayouts` |
| `app/styledata/style.service.ts` | `styleVisiblity`, `styleEditorTarget` |
| `app/diagnostics/diagnostics.facade.service.ts` | `diagnosticsLogFilter`, `diagnosticsExportOptions` |
| `app/shared/app-config.service.ts` | `distributionVersions`, `erdblickVersion` |
| `app/inspection/inspection-state.service.ts` | `selected`, `inspectionsLimitState`, `drillPickRadius`, `inspectionTreeExpandByDefault`, `sourceDataInspectionDefaultColumns`, `inspectionTreeHiddenColumns`, `inspectionValueVaryColors`, `inspectionValueVaryOutlines`, `inspectionValueVaryStriping`, `hoverLabelsEnabled`, `hoverLabelFields`, `inspectionComparisonState` |
| `app/search/location.search.service.ts` | `locationSearchResultLimit` |
| `app/search/feature.search.service.ts` | `featureSearchGrouping`, `featureSearchState` |

There are 71 registrations: the 70 release keys plus `viewIds`. `numberOfViews` is a projection of ordered IDs; `focus` stores a logical ID with the old numeric codec. The deployed spelling `styleVisiblity` is retained for compatibility.

### Method migration

| Former AppState behavior | Current owner |
| --- | --- |
| View count, camera, projection, sync, background and grid edits | `MapViewStateService`; renderer workflows in `MapViewService` |
| Layer defaults, aligned arrays, option writes and preset selections | `MapLayerStateService`; catalog/preset coordination in `MapInfoService` |
| Feature/source selection, panel locking/focus/colors, comparison and cleanup | `InspectionStateService`; async work in `InspectionSelectionService` |
| Search definitions and grouping | `FeatureSearchService` |
| Style visibility and editor preference | `StyleService` |
| Marker/coordinate preferences and policy | `CoordinatesService`, `CoordinatesPolicyService` |
| Rendering and connection preferences | `RenderPreferencesService`, `ConnectionPreferencesService` |
| Generic dialog/dock/split layout | `AppLayoutService` |
| Version, diagnostics and location preferences | `AppConfigService`, `DiagnosticsFacadeService`, `LocationSearchService` |
| Shared v1/v2 layer/style/selection URL dictionary | `AppUrlStateService` |
| Generic storage/config ownership, validation, batching, snapshots and navigation persistence | `AppStateService` |

Domain operations were moved to these owners; ordinary consumers inject them directly. There is no forwarding domain facade on `AppStateService`. Persisted schemas remain beside their owners. Named public control/action schemas are in each owner’s `.service.declarations.ts` companion.

Raw line counts include moved code, formatting and comments and should not be treated as a complexity metric. The independent implementation comparison records separate production, infrastructure, test and generated-artifact changes.
