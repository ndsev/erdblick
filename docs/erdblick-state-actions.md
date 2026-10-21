# State Owners and Actions

Start with the service responsible for the behavior. A view's camera belongs to
`MapViewStateService`; loading feature wrappers belongs to
`InspectionSelectionService`; panel selection, locking and comparison belong to
`InspectionStateService`. Components call these owners directly. MCP and the
omnibar bind to the same methods through named controls and actions.

## Find the Owner

| Owner | Responsibility |
| --- | --- |
| `MapViewStateService` | Logical view membership, focus, camera, projection, synchronization, marker and navigation preferences |
| `MapViewService` | Live renderer registrations, navigation and coverage coordination |
| `MapLayerStateService` | Layer visibility/levels, backgrounds, grids, options and preset associations |
| `MapInfoService` | Available map/style catalog, applying complete presets and pruning catalog references |
| `InspectionStateService` | Panels, selection, comparison and inspection/hover preferences |
| `InspectionSelectionService` | Async feature resolution, inspection wrappers and feature fitting |
| `FeatureSearchService` | Persisted search definitions, live searches, target IDs and results |
| `StyleService` | Installed styles, visibility and editing |
| `AppLayoutService` | Dock, dialog and split proportions |
| `DiagnosticsFacadeService` | Diagnostics filters, exports and diagnostic read operations |
| `AppUrlStateService` | URL dictionaries, positional projections, hydration and share links |
| `AppStateService` | Codec registration, storage, snapshots, config ownership and transaction coordination |

Coordinate settings, location search preferences, transport preferences and editor
requests likewise live beside their existing services. There is no application
service exposing all owners' domain methods.

### Deployed Storage Keys

The [frozen release inventory](../test/persisted-state-keys.json) contains the 70
existing keys. The complete-owner fixture's
[registration test](../app/shared/state-write-origin.spec.ts) verifies those keys
exactly once at runtime, plus the deliberate new `viewIds` key. The historical
`styleVisiblity` spelling remains unchanged for storage compatibility.

| Owner | Registered keys |
| --- | --- |
| `MapViewStateService` | `viewIds`, `numberOfViews`, `focus`, `marker`, `markedPosition`, `viewSync`, `cameraView`, `mode2d`, `deckAntialiasingEnabled`, `semanticCompositingEnabled`, `contactShadingEnabled`, `lod3TileThreshold`, `tileSubsetRenderWorkerCount`, `pointCloudDownsamplingEnabled`, `pointCloudDetailPixels`, `pointCloudWorkingMemoryMiB`, `pointCloudGpuMemoryMiB`, `mapZoomStep`, `featureZoomClearanceMeters`, `tilesLoadLimit` |
| `MapLayerStateService` | `layerSyncOptions`, `background`, `layerNames`, `visibility`, `tileBorders`, `tileGridMode`, `tileGridLevel`, `tileGridAutoLevel`, `tileGridColor`, `tileGridOpacity`, `zoomLevel`, `autoZoomLevel`, `stylePresetSelection`, `mapPresetSelection`, `mapsOpenState`, `styleOptions` |
| `InspectionStateService` | `selected`, `inspectionsLimitState`, `drillPickRadius`, `inspectionTreeExpandByDefault`, `sourceDataInspectionDefaultColumns`, `inspectionTreeHiddenColumns`, `inspectionValueVaryColors`, `inspectionValueVaryOutlines`, `inspectionValueVaryStriping`, `hoverLabelsEnabled`, `hoverLabelFields`, `inspectionComparisonState` |
| `AppLayoutService` | `dockOpenState`, `dockWidth`, `viewPanelSizes`, `dockActiveTabState`, `dockAutoCollapse`, `dialogLayouts` |
| `MapTileStreamService` | `tilePullCompressionEnabled`, `connectionRetryEnabled`, `connectionRetryInitialDelayMs`, `connectionRetryBackoffMultiplier`, `connectionRetryMaxDelayMs` |
| `CoordinatesService` | `coordinatesEnabled`, `coordinatesLegalTermsAccepted`, `enabledCoordsTileIds` |
| `FeatureSearchService` | `featureSearchGrouping`, `featureSearchState` |
| `DiagnosticsFacadeService` | `diagnosticsLogFilter`, `diagnosticsExportOptions` |
| `AppConfigService` | `distributionVersions`, `erdblickVersion` |
| `LocationSearchService` | `locationSearchResultLimit` |
| `StyleService` | `styleVisiblity` |
| `StyleEditorRequestService` | `styleEditorTarget` |

These are codec keys, not a promise that every value appears in every snapshot or
URL. Each declaration retains its existing snapshot/config/URL flags. For example,
search definitions persist locally but do not enter exported snapshots, and style
options use their compact per-option keys through the specialized codec.

## Declare a Value Beside Its Owner

A named declaration keeps its default, schema and external storage key together.
For example, [diagnostics.facade.service.state.ts](../app/diagnostics/diagnostics.facade.service.state.ts)
contains:

```ts
export const diagnosticsLogFilter: AppStateOptions<DiagnosticsLogFilter> = {
    name: "diagnosticsLogFilter",
    defaultValue: {info: true, warn: true, error: true},
    schema: z.object({info: Boolish, warn: Boolish, error: Boolish})
};
```

That file's `withDiagnosticsState()` feature initializes `diagnostics.logFilter`
from this declaration's default. `ViewerStore` composes owner features using
NgRx SignalStore. The service binds the codec to that exact store location:

```ts
readonly diagnosticsLogFilterState = this.stateService.register(
    diagnosticsLogFilter, "diagnostics", "logFilter"
);
readonly logFilter = this.diagnosticsLogFilterState.signal;

set diagnosticsLogFilter(value: DiagnosticsLogFilter) {
    this.diagnosticsLogFilterState.next({...value});
}
```

The two location arguments are checked against the store's slice/member types.
`AppState` supplies validation, serialization and notification access; the value
itself exists only in SignalStore. Defaults are copied once for initialization,
not on ordinary reads. Treat `getValue()`, signal results and Observable payloads
as immutable: replace an array, object or Map when editing it. Read-only signals
do not freeze nested objects; the owner methods preserve that discipline.

For larger owners, a `*.service.state.ts` companion contains named declarations
and the initialized feature. A `*.service.declarations.ts` companion contains
public controls/actions. Both filenames identify the service, and the service's
static properties reference those exact declarations. Small contracts can remain
inline on the class.

## Read with Signals or RxJS

Native signals are ordinary read-only Angular signals. A component can derive a
value without an Observable adapter:

```ts
readonly visibleLogLevels = computed(() => {
    const filter = this.diagnostics.logFilter();
    return Object.entries(filter).filter(([, enabled]) => enabled);
});
```

An existing RxJS consumer can use the same authoritative value:

```ts
this.diagnostics.diagnosticsLogFilterState
    .pipe(takeUntilDestroyed())
    .subscribe(filter => this.refreshLogRows(filter));
```

Signal readers depend on the specific store member. Per-view readers use
`cameraViewDataState.signal(viewId)` and continue reading the same camera when the
view order changes. One NgRx `watchState` observation fans out synchronous RxJS
notifications; there is no whole-store watcher for each slot or subscriber.

## Commit Complete Owner Operations

Methods such as `setView`, `setProjectionMode`, `setMarkerControl` and preset
application use `stateService.transaction(...)` themselves. Ordinary UI calls
therefore publish coherent state, including synchronized views and preset option
values. An MCP call may nest that transaction without changing the owner rule.

Transactions are synchronous. Validation and preparation happen before the
SignalStore patch. An exception discards that transaction's writes; nested failure
restores the enclosing draft. A write made by a synchronous subscriber is queued
for the next coherent publication, so later subscribers still see the current
revision. A change reverted within the transaction emits nothing. Async owners
capture a target, await outside the transaction, revalidate it and then commit.

Storage ownership travels with each committed write. System normalization,
configuration and hydration do not become user edits merely because a subscriber
queued them. User edits retain their ownership across later config defaults.

## Keep View Identity Separate from Position

`MapViewStateService` owns ordered logical IDs and uses NgRx Entities for their
runtime lifetimes. IDs contain 1–64 letters, digits, `_` or `-`; Object.prototype
property names are reserved. There are 1–32 unique views. A runtime generation
changes whenever an ID is removed and later restored. It is not stored in links.

Camera/layer/option records are keyed by ID. Their initialized features contain
empty records because no UI pane exists before view membership is established.
`registerView` materializes each live pane from the same declared per-view default
and projects the records into positional arrays for existing storage codecs.
It does not create a second authoritative positional value.

UI indices are presentation coordinates. Renderers and async operations capture
an ID plus generation, check it after waits, and resolve its current index only
when applying work. Reorder retains camera, layers, search references and renderer
associations. Removal retires the target, even if a later import restores its ID.

`vid` stores the ordered IDs in the URL. Explicit IDs determine count when `n` is
absent; an explicit count must match. Malformed or duplicate IDs reject before
other fields change, and startup reports the bad link while remaining usable.
Empty startup and partial legacy links preserve saved IDs, resizing the mapping
for the effective count. Full replacement without IDs creates a fresh mapping
once. Omitted legacy camera/layer fields retain their positional compatibility.
Live search associations retain surviving IDs and prune removed ones; they never
transfer by position. A newly created view inherits search selection only from
its explicit source. Count expansion uses the preceding view as that source.

## Register Controls and Actions

A control is a named readable value, optionally writable as one complete value.
An action is a semantic operation. Declarations use ordinary Zod schemas beside
the owner; binding supplies the actual reader/setter or handler:

```ts
actions.registerControl(MapViewStateService.controls.marker, {
    read: () => this.markerControl(),
    write: (_, value) => this.setMarkerControl(value)
});

this.actions.registerAction(
    InspectionStateService.actions.closeInspection,
    ({panelId}) => this.closeInspection(panelId),
    {suggest: query => this.closeInspectionSuggestions(query)}
);
```

`closeInspectionSuggestions` supplies concrete “Close <feature>” choices with a
panel ID and a runtime lifetime check. Selecting one executes the exact registered
`closeInspection` action. These transient choices are excluded from history;
reusing a numeric panel ID cannot make an old candidate valid again.

Coordinate, source-data, feature-jump, plugin, location and external-viewer
operations use the same action boundary with `exposure: "omnibar"`. For example,
`CoordinateJumpService.actions.navigate` declares `parser`, `query` and a captured
view identity. Each of the six coordinate presentations supplies those arguments
through `actions.candidate(...)`. Configured plugins and network providers supply
candidate metadata; their execution still enters a fixed typed owner action.
They are not exported as MCP tools.

`SearchPanelComponent` owns query debounce, display and history selection. It does
not move cameras or write markers. Saved entries are resolved into fresh
candidates after their saved view ID is resolved. Location lookup subscriptions
cancel on newer navigation, user gestures, reset or retired targets. Async jump
failures return to the panel's normal error handling.

## Export and Bind the Same Contract

[viewer-action.contract.ts](../app/actions/viewer-action.contract.ts) collects
static declarations from actual owners. The build exporter bundles that import
graph for Node and reads static properties without constructing services. It
therefore needs no DOM, Angular application bootstrap or WASM initialization.
`npm run generate:viewer-actions` first typechecks the exporter, then generates
the wire artifact consumed by mapget and the browser.

The application initializer constructs owners, registers generic controls, checks
that every expected declaration object is bound exactly once, then seals action
and control registration. Missing, extra, duplicated or late bindings fail there.
Dynamic omnibar providers have separate registration cleanup and may change with
configuration. Static public declarations remain fixed for the tab lifetime.

The public entry points are `viewer_describe_controls`, `viewer_get_controls` and
`viewer_set_control`; targets use `{control, viewId?, ...selector}`. Owner discovery
uses `viewer_list_maps`, `viewer_list_layers`, `viewer_list_backgrounds`,
`viewer_list_styles`, `viewer_list_style_options` and `viewer_list_presets`.
Generic reads and discovery enforce item/byte budgets and report omissions,
including the first omitted default target and remaining count. Browser and
native schemas validate control values for both requests and responses. Mapget's
version-1 artifact still calls its metadata field `channels`.

Browser diagnostics and integration fixtures can call
`await window.ebDebug.executeAction(name, input)` through that same validated
registry, including when the MCP adapter is disabled. Generic snapshot reads
remain available through `window.ebDebug.stateService.exportSnapshot()` and use
the declared storage encoding rather than the runtime control representation.

## URL State and Pruning Remain Explicit

`AppUrlStateService` constructs shared map/layer dictionaries, applies compact
selection/style codecs, and coordinates URL projections with the owners. Generic
`AppStateService` retains routing, debounce and storage mechanics. Snapshot and
config identity normalization use the view owner before applying other fields.
The specialized `StyleState` codec preserves compact option keys and its existing
snapshot/config ownership granularity.

When the authoritative source catalog changes, `MapInfoService` coordinates one
system transaction calling `MapLayerStateService.prune`,
`StyleService.pruneVisibility` and `InspectionStateService.prune`. Each owner
implements its own invariants. Layer/style getters remain reads; materializing
config defaults is an explicit system operation.
