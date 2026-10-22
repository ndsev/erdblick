# Application State and Actions

Inject `AppStore` to read application values or call their operations. Its domain
features contain the state declarations, persistence codecs and operations.
`AppStateService` discovers the codecs from the composed store and handles browser
storage, snapshots and routing. Components do not inject a second state service.

## Start with These Terms

| Term | Meaning in erdblick | Example |
| --- | --- | --- |
| State | The current application values | Cameras, selected layers, inspection panels, dock width |
| Slice | A group of native store values owned by one domain feature | `store.layout`, `store.inspection` |
| Signal | A read function Angular can track | `store.layout.dockOpen()` |
| Persisted field / old slot | A value with its released storage and URL conversion rules | `dockOpen` still uses the `dockOpenState` local key |
| Control | An explicitly exposed readable projection, optionally writable as a complete value | `view.camera` reads the live renderer and uses the normal camera operation |
| Action | A named operation with input/output schemas and an execution handler | Open an inspection, start a search, export a style |
| Feature | A function that contributes state, methods or metadata to the same injected store | `withAppLayout()` |
| Resource service | An owner of ongoing external work or disposable objects | `MapViewService` owns live renderer registrations |

A stored field does not automatically become a public MCP control. Selection
state contains internal bookkeeping; `app.selections` deliberately publishes only
bounded panel and feature identities. Controls can also read live resources whose
values are unsuitable for persistence.

## Where to Read the Code

| File / feature | Responsibility |
| --- | --- |
| [`app.store.ts`](../app/shared/app.store.ts) | Compose the domain features into one Angular-injected `AppStore` |
| [`app-layout.store-feature.ts`](../app/shared/app-layout.store-feature.ts) | Dock, dialogs and split proportions; a useful first example |
| [`map-view.store-feature.ts`](../app/mapview/map-view.store-feature.ts) | Logical view lifetimes, cameras, projection, focus, synchronization and navigation preferences |
| [`map-layer.store-feature.ts`](../app/mapdata/map-layer.store-feature.ts) | Layer settings, backgrounds, grids, style options and preset associations |
| [`map-catalog.store-feature.ts`](../app/mapdata/map-catalog.store-feature.ts) | Prepare catalog and preset changes across layer, style and inspection values |
| [`inspection.store-feature.ts`](../app/inspection/inspection.store-feature.ts) | Selection panels, comparison, presentation and inspection preferences |
| [`feature-search.store-feature.ts`](../app/search/feature-search.store-feature.ts) | Persisted search definitions and their presentation |
| Other domain `*.store-feature.ts` files | Coordinate, style, connection, diagnostics, location and config preferences |
| Domain `*-actions.store-feature.ts` files | Operations that call a resource engine, with their public schemas |
| [`persisted-state.ts`](../app/shared/persisted-state.ts) | Declare native state with codec metadata; synchronous resource observation and write provenance |
| [`state-codec.ts`](../app/shared/state-codec.ts) | Existing scalar, array and style-option serialization algorithms, without reactive state |
| [`action.ts`](../app/actions/action.ts), [`control.ts`](../app/actions/control.ts) | Attach validated public metadata to a callable or projection |
| [`app-action.ts`](../app/actions/app-action.ts) | Discover metadata, dispatch operations, collect omnibar candidates and enforce response budgets |
| [`appstate.service.ts`](../app/shared/appstate.service.ts) | Browser storage, config ownership, validated imports and URL scheduling |
| [`app-url-state.service.ts`](../app/shared/app-url-state.service.ts) | URL dictionaries, compact projections and share links |

`MapInfoService`, `MapViewService`, `InspectionSelectionService`, `FeatureSearchService`
and `StyleService` remain resource engines. They own catalog/parser lifetimes,
renderers, feature loading, search execution and YAML/native styles respectively.
The old `AppLayoutService`, `MapViewStateService`, `MapLayerStateService` and
`InspectionStateService` wrappers are removed.

### Deployed Storage Keys

The [frozen release inventory](../test/persisted-state-keys.json) contains the 70
existing keys. The store fixture's
[discovery test](../app/shared/state-write-origin.spec.ts) verifies those keys
exactly once at runtime, plus the deliberate new `viewIds` key. The historical
`styleVisiblity` spelling remains unchanged for storage compatibility.

| Owner | Persisted keys |
| --- | --- |
| `withMapViewState` | `viewIds`, `numberOfViews`, `focus`, `marker`, `markedPosition`, `viewSync`, `cameraView`, `mode2d`, `deckAntialiasingEnabled`, `semanticCompositingEnabled`, `contactShadingEnabled`, `lod3TileThreshold`, `tileSubsetRenderWorkerCount`, `pointCloudDownsamplingEnabled`, `pointCloudDetailPixels`, `pointCloudWorkingMemoryMiB`, `pointCloudGpuMemoryMiB`, `mapZoomStep`, `featureZoomClearanceMeters`, `tilesLoadLimit` |
| `withMapLayerState` | `layerSyncOptions`, `background`, `layerNames`, `visibility`, `tileBorders`, `tileGridMode`, `tileGridLevel`, `tileGridAutoLevel`, `tileGridColor`, `tileGridOpacity`, `zoomLevel`, `autoZoomLevel`, `stylePresetSelection`, `mapPresetSelection`, `mapsOpenState`, `styleOptions` |
| `withInspectionState` | `selected`, `inspectionsLimitState`, `drillPickRadius`, `inspectionTreeExpandByDefault`, `sourceDataInspectionDefaultColumns`, `inspectionTreeHiddenColumns`, `inspectionValueVaryColors`, `inspectionValueVaryOutlines`, `inspectionValueVaryStriping`, `hoverLabelsEnabled`, `hoverLabelFields`, `inspectionComparisonState` |
| `withAppLayout` | `dockOpenState`, `dockWidth`, `viewPanelSizes`, `dockActiveTabState`, `dockAutoCollapse`, `dialogLayouts` |
| `withMapTileStream` | `tilePullCompressionEnabled`, `connectionRetryEnabled`, `connectionRetryInitialDelayMs`, `connectionRetryBackoffMultiplier`, `connectionRetryMaxDelayMs` |
| `withCoordinates / withCoordinatesPolicy` | `coordinatesEnabled`, `coordinatesLegalTermsAccepted`, `enabledCoordsTileIds` |
| `withFeatureSearch` | `featureSearchGrouping`, `featureSearchState` |
| `withDiagnosticsState` | `diagnosticsLogFilter`, `diagnosticsExportOptions` |
| `withAppConfig` | `distributionVersions`, `erdblickVersion` |
| `withLocationSearch` | `locationSearchResultLimit` |
| `withStyle` | `styleVisiblity` |
| `withStyleEditorRequest` | `styleEditorTarget` |

These are codec keys, not a promise that every value appears in every snapshot or
URL. Each declaration retains its existing snapshot/config/URL flags. For example,
search definitions persist locally but do not enter exported snapshots, and style
options use their compact per-option keys through the specialized codec.

## A Small Feature, End to End

The layout feature declares its current value and released storage key together:

```ts
withPersistedState<"layout", AppLayoutValues>("layout", {
    dockOpen: {
        name: "dockOpenState",
        defaultValue: false,
        schema: Boolish
    },
    // The other layout fields use the same shape.
});
```

`withPersistedState` adds native NgRx state and inert codec descriptors. A descriptor
knows how to convert a supplied value; it has no cached value, subscription or
`.next()` method. `AppStateService` finds those descriptors by inspecting the
composed store. `AppUrlStateService` discovers the same descriptors and prepares
URL projections; persistence calls it through ordinary dependency injection.
There is no per-service persistence registration call.

An ordinary feature method changes the native state:

```ts
setDockOpen(open: boolean): void {
    patchAppState(store, {
        layout: {...store.layout(), dockOpen: open}
    });
}
```

`patchAppState` calls NgRx `patchState` once for a prepared change. It also labels
which released keys were changed by the user, config, hydration or system work.
That label lets browser persistence preserve user overrides across config updates.
It is not a transaction, staged draft or alternate reactive store.

Treat arrays, objects and Maps obtained from signals as immutable. Replace changed
values through feature methods; Angular's read-only signal API does not prevent
mutating an object obtained from a signal. External imports and public action/control
inputs use their schemas. Internal methods enforce their own domain constraints.

## How a Consumer Subscribes

For a template, reading the signal is the subscription:

```ts
readonly store = inject(AppStore);
```

```html
<p-checkbox
    [ngModel]="store.layout.dockAutoCollapse()"
    (ngModelChange)="store.setDockAutoCollapse($event)" />
```

For a derived value, use `computed` and read the relevant signals inside it:

```ts
readonly visibleLogLevels = computed(() => {
    const filter = this.store.diagnostics.logFilter();
    return Object.entries(filter).filter(([, enabled]) => enabled);
});
```

Angular computes this on demand and caches the result until a dependency changes.
A per-view component can read `store.views.cameraViewData()[viewId]`; its logical
ID remains stable when panels are reordered. Creating a derived signal does not
start a subscription loop, allocate another copy of the store, or run its calculation
on every application update. See [Angular's signal guide](https://angular.dev/guide/signals).

Use an Angular `effect` when synchronizing a component's editable UI draft. Keep
resource timing explicit. Some resource owners must react synchronously: an
inspection loading model must exist before the dock mounts and measures it.
`observeStore` adapts NgRx's synchronous `watchState` to RxJS for those owners:

```ts
observeStore(store, state => state.inspection.selection)
    .pipe(takeUntilDestroyed())
    .subscribe(panels => this.reconcileSelection(panels));
```

One subscription observes each native store publication and compares its selected
value by identity unless the caller supplies another comparator. Select a complete
input when several fields must agree; combining separately observed fields can
produce intermediate combinations. Unsubscribe with the owning component/resource.
This path is for runtime projection, not for repairing application state after it
has been published. Normal UI reads use the store signals directly.

## Prepare Complete Changes Before Publication

Closing an inspection affects selection, focus, comparison and layout. Removing a
view affects cameras, layer/style records, search targets and runtime identity.
The semantic feature method calculates those related values first, then publishes
one native patch. Observers receive a complete result.

There is no generic transaction manager, rollback stack or publication queue.
Pure preparation functions can be reused by URL/snapshot import and ordinary
operations. An invalid import fails before publication. A resource engine captures
its target, performs asynchronous work, rechecks cancellation and target lifetime,
and calls the semantic store method only when the result is still applicable.

Resource projections must not write back into the store merely to make its values
consistent. Keep normalization in the initiating operation. If the UI needs a
runtime object before measuring itself, explicitly reconcile that resource before
measurement. This replaces the former global `afterStatePublication` phase.

## View Identity and Old Links

NgRx Entities holds each logical view's ID and runtime generation. The generation
changes when an ID is removed and later restored; it never enters storage or links.
Cameras, layers and options are records keyed by ID. Positional arrays are created
only at the compatibility boundary for the released codecs.

UI indices are presentation coordinates. Async work captures an ID and generation,
checks them after waiting, and resolves the current index when applying its result.
Work using a physical renderer also checks that exact renderer is still registered.
PrimeNG can recreate renderers during a same-count reorder without retiring the
logical view. Conversely, removing a view retires its logical lifetime.

`vid` contains the ordered IDs in a link. Explicit IDs determine count when `n` is
absent; an explicit count must match. Invalid or duplicate IDs reject the import
before other fields change. Old links without IDs generate the required mapping
from the effective count; partial imports retain saved IDs where possible. Full
replacement without IDs establishes a fresh mapping once. Search targets retain
surviving IDs rather than transferring to a new view at the old position.

## Operations Carry Their Public Metadata

`action(...)` returns an ordinary typed callable with discovery metadata attached.
The inspection feature declares `closeInspection` next to its implementation:

```ts
closeInspection: action({
    name: "viewer_close_inspection",
    description: "Close one inspection panel, including a pinned panel.",
    mutation: true,
    inputSchema: z.strictObject({panelId: z.number().int().nonnegative()}),
    outputSchema: z.strictObject({
        status: z.literal("applied"),
        changed: z.boolean()
    })
}, ({panelId}) => {
    // Validate the live target, then perform the feature's complete panel removal.
    unsetPanel(panelId);
    return {status: "applied" as const, changed: true};
});
```

This shortened example omits the real method's missing-target check and omnibar
suggestions. The full implementation also supplies concrete “Close <feature>”
candidates. Each carries the panel ID and generation, so a menu opened before
removal cannot accidentally close a later panel that reuses that numeric ID.

A control attaches `read`, optional `write`, and optional default-overview selectors
to its schema. These functions use the same semantic methods as the UI. Small
schemas are inline; larger public schemas remain named in the owning feature file
so resource handlers can derive their input/output types from them.

`withViewerActions()` is composed last and builds `store.actionCatalog` from
annotated methods, controls and omnibar providers. No service registers a handler
or repeats a list of expected names. The catalog derives the three generic control
operations from the discovered controls. `mutation` determines the MCP permission.
`exposure: "omnibar"` keeps a local command out of the public MCP inventory.

Resource action features capture Angular's injector during construction and resolve
their resource service only on invocation. They do not start network/render work
while the store is being composed. Synchronous handlers stay synchronous, preserving
the click gesture needed by `window.open`; asynchronous handlers retain their
cancellation context and return their actual Promise.

Coordinate, location, external-viewer, feature and plugin suggestions use fixed
typed store actions. `store.actionCatalog.candidate(store.jumpCoordinates, ...)`
binds a concrete suggestion to that callable. Search providers can supply current
results without modifying the public action inventory. `SearchPanelComponent`
continues to own debounce, display and history selection.

## Build-Time MCP Discovery

`npm run generate:viewer-actions` typechecks and bundles the actual `AppStore`
composition for Node. It creates that store inside an empty Angular injector,
reads `store.actionCatalog`, and writes the generated schemas/catalog hash. No
DOM, local storage, application bootstrap, network or WASM startup is provided.
A feature that eagerly tries to start a resource fails this build step.

Mapget consumes the packaged JSON beside the webapp entry point. Node is needed
only during the frontend build. `ViewerActionService` and `WebMcpService` use the
same discovered catalog in the browser; neither maintains a second public list.
The generic public operations remain `viewer_describe_controls`,
`viewer_get_controls` and `viewer_set_control`. Targets use
`{control, viewId?, ...selector}`. The artifact's version-1 metadata field is still
called `channels` for mapget interoperability.

Bounded reads/discovery report omitted values. Browser and native validation use
the same generated control schemas for inputs and results. Browser diagnostics
can call `window.ebDebug.executeAction(name, input)` through the same catalog.
`window.ebDebug.stateService.exportSnapshot()` remains the separate persisted
representation, including its released storage encodings.

## URL, Config and Catalog Pruning

`AppUrlStateService` still builds shared map/layer dictionaries, applies compact
selection/style projections, preserves unknown query parameters for ordinary
navigation and constructs sanitized share links. `AppStateService` still owns
router integration, debounce, local storage and per-key config provenance.

Hydration first prepares the logical membership, then decodes positional values
against that mapping, normalizes cross-domain invariants, and publishes once.
The specialized style-options codec retains its compact keys and granular config
ownership. SignalStore changes the internal value owner; it does not replace these
serialization rules or make all values shareable.

`MapInfoService` interprets catalog readiness and determines whether pruning is
allowed. Initializing or failed sources retain recoverable state. Complete catalog
changes prepare layer/style/inspection cleanup as one system operation. Native
parser identity, dictionary lifetime and resource disposal remain in the service.
Materializing defaults is an explicit operation; getters remain reads.

For the library mechanisms behind the domain features, see NgRx's
[custom features](https://ngrx.io/guide/signals/signal-store/custom-store-features)
and [state tracking](https://ngrx.io/guide/signals/signal-store/state-tracking).
The installed dependency in this branch is NgRx Signals 21.0.0.
