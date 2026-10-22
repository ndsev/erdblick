# Application models, controllers and actions

The application keeps its existing `AppState<T>`, `MapViewState<T>` and
`StyleState` abstractions. Each domain now has an injectable **model** containing
its values, persistence declarations and state-only projections. A **controller**
uses those values to perform workflows and contributes its actions and controls.
`AppStateService` coordinates persistence and completed observations across models.

This separates state access from runtime dependencies. Reading dock preferences
should not construct the dialog controller; reading search definitions should not
construct the search engine, map catalog or renderer.

## Where to look

| Folder | Contents |
| --- | --- |
| `app/state/` | AppState primitives, publication, storage/config ownership, URL coordination and codecs |
| `app/layout/` | Dock/dialog/panel components, layout model and layout controller |
| `app/config/` | Configuration loader, published-version model and background definitions |
| `app/actions/` | Action registry, MCP adapters and UI automation |
| `app/omnibar/` | Command palette, history compatibility codecs and `OmnibarModel` |
| `app/navigation/` | Coordinate/feature jumps, location navigation and external viewers |
| `app/feature-search/` | Feature-search definitions, execution, completion, result presentation and `FeatureSearchModel` |
| `app/location-search/` | Place providers, location geometry and `LocationSearchModel` |
| `app/rendering/`, `app/connection/` | Rendering/resource policies and connection preferences, with their models/controllers |
| `app/mapview/`, `app/mapdata/`, `app/inspection/`, `app/coordinates/`, `app/map-styles/`, `app/diagnostics/` | The corresponding domain's model, controllers and presentation |
| `app/styles/` | Application CSS; map-feature style documents belong to `app/map-styles/` |

Each folder owning shared application state has exactly one `<folder>.model.ts`,
containing its injectable `<Folder>Model`. Multiple controllers may use that model.
The `.model.ts` suffix is reserved for this owner: value types and runtime objects
use descriptive `.types.ts` or ordinary TypeScript filenames. Infrastructure and
stateless helper folders do not acquire empty models.

Models have no runtime dependency on controllers. State normalization, positional
compatibility codecs and membership invariants stay with the values they protect.
Network, renderer, worker and UI workflows stay in controller services. For example,
`MapViewModel` keeps logical membership and per-view records coherent during URL
hydration, before renderers exist. Components retain private interaction details
such as caret position and pointer capture.

The main service boundaries are:

| Owner | Responsibility |
| --- | --- |
| `MapViewModel` | Durable identities, committed cameras, projection/sync values, positional codecs and coherent membership edits |
| `MapViewService` | Renderer lifetimes, live camera previews, navigation, view teardown and public view actions/controls |
| `MapDataModel` | Layer values, style-option associations, preset selections and their state invariants |
| `MapInfoService` | Loaded catalog/tree, preset application and complete-catalog cleanup |
| `InspectionModel` | Persisted selections, panel preferences, comparison data and codecs |
| `InspectionPanelService` | Panel lifetime, focus, locks, comparison and layout workflows |
| `InspectionSelectionService` | Asynchronous feature loading, selection projection and navigation |
| `FeatureSearchModel` | Saved definitions, grouping and logical view associations |
| `FeatureSearchService` | Live sessions, completion, worker/transport coordination and search actions |
| `ActionRegistry` | Shared registration, schema validation and dispatch for omnibar and MCP |
| `McpActionService` | Connection registration, admission, deadlines, cancellation and Angular scheduling |
| `UiAutomationService` | Bounded DOM snapshot identities, resizing, interaction and screenshots |

`ActionRegistry` and `McpActionService` have separate lifetimes and responsibilities:
the omnibar uses the registry even when MCP is disabled. The transport adapter has
no domain dispatch switch or separate action catalog. Likewise, `MapViewModel`
works without renderer construction, while `MapViewService` owns the live resources
that must be retired before a view disappears.

## Declaring and observing state

`CoordinatesModel` keeps the deployed key and URL codec next to the value:

```ts
readonly markerState = this.persistence.registerState<boolean>({
    name: "marker",
    defaultValue: false,
    schema: Boolish,
    urlParamName: "m",
    urlIncludeInVisualizationOnly: false
});
```

A component which only observes state injects the model directly:

```ts
constructor(readonly layout: LayoutModel) {
    this.subscription = layout.dockOpenState.subscribe(open => {
        // Update this component's presentation from the current dock preference.
        this.dockVisible = open;
    });
}
```

As with the existing AppState system, the consumer releases its subscription when
it is destroyed. Controllers inject their models as readonly dependencies, usually
named `model`. A consumer that also invokes a controller can use that same instance
through, for example, `coordinatesService.model`; state is neither copied nor
forwarded through getters.

For a coherent observation spanning several slots, use a completed projection:

```ts
persistence.observe(() => ({
    enabled: coordinates.markerState.value,
    position: coordinates.markedPositionState.value
})).subscribe(marker => updateMarkerOverlay(marker));
```

`updateMarkerOverlay` denotes the consumer's rendering work. The model does not
perform rendering. `CoordinatesService.setMarker()` batches the position and
visibility changes in the ordinary AppState transaction.

## Controller registration

A **control** is an explicit public value reader/writer. It may combine several
stored slots or describe runtime state. An **action** is a semantic operation,
such as closing a particular inspection or starting a search. Neither name is a
persistence key, and models are not automatically exposed to MCP.

Controllers implement `AppActionContributor`. Its two optional methods distinguish
operations from controls without requiring empty implementations:

```ts
registerActions(actions: ActionRegistry): void {
    actions.registerAction(
        {
            name: "viewer_close_inspection",
            description: "Close one inspection, rejecting a stale lifetime when supplied.",
            mutation: true,
            inputSchema: z.strictObject({
                panelId: indexSchema,
                lifetime: indexSchema.optional()
            }),
            outputSchema: z.strictObject({
                status: z.literal("applied"),
                changed: z.boolean()
            })
        },
        ({ panelId, lifetime }) => {
            this.closeInspection(panelId, lifetime);
            return applied();
        },
        query => this.closeInspectionCandidates(query)
    );
}
```

Declarations are inline in `registerActions()` and `registerControls()`, immediately
beside their execution or read/write callbacks. The registry infers callback types
from the schemas. Controller methods use domain parameters and inferred results;
they do not obtain their types from a separately exported action catalog.

Controls use the same layout with `selectorSchema` and `valueSchema` in the first
argument, followed by `read`, `write` and optional `defaultTargets` callbacks.
See [CoordinatesService](../app/coordinates/coordinates.service.ts) for a compound
marker control and [MapViewService](../app/mapview/map-view.service.ts) for scoped
camera/layer controls. Shared validators remain named when other operations use
them, such as camera validation, feature references and search settings.
There are no `.declarations.ts` companions or exported declaration maps.

A choice such as `Close Road.17` carries a panel ID and captured lifetime. The
handler checks the lifetime before acting. MCP obtains the same identity through
`app.selections`. There is no unparameterized, ambiguous “close inspection” menu
entry. Local-only operations declare `exposure: "omnibar"`; candidate production
is never executed during catalog collection.

`registerApplication()` is the single composition point for controller instances.
It constructs their models and the independently owned omnibar model, seals
persistence registration, and passes the
controllers to `ActionRegistry.registerContributors()`. All controls register
first, then operations; the registry derives `viewer_describe_controls`,
`viewer_get_controls` and `viewer_set_control` from those registered controls.
Duplicate and late registrations fail. There is no second production list of
expected declarations to keep aligned.

Browser startup then loads config, seeds config defaults, initializes WASM,
hydrates persistence and starts coordinates/styles/catalog/transport/search in the
existing order. Registration never calls the runtime initializer.

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

## Catalog generation in Node

`npm run generate:viewer-actions` now runs a flavor of the actual Angular
application. `tools/build-viewer-actions.mjs` compiles the entry point with Angular's
compiler, bundles the emitted code for Node and supplies a disposable jsdom
application document. `tools/export-viewer-actions.ts` constructs an Angular
application injector and calls the same `registerApplication()` as the browser.

No component is mounted, deployment config is loaded, WASM is initialized, or
search/renderer/socket startup is invoked. The collector reads the registered
metadata without calling state readers, handlers or omnibar candidate providers.
A network request during collection fails the build. The injector and disposable
document are destroyed when collection finishes.

The output is the static `web-mcp-actions.json` manifest, its canonical JSON, the
catalog hash used by the browser, the relay schemas and generated TypeScript
contract types. The type compiler runs in Node after the disposable browser
environment has been removed. The manifest currently
contains 32 public actions and 21 controls. Permissions derive from each action's
`mutation` flag. Mapget continues to read the static artifact; Node is required
only on the build machine.

Collection runs **before the final browser bundle**, so that bundle can embed the
matching hash and copy the manifest beside `index.html`. It is a build stage, not
server-side discovery. The existing start/build/watch/test lifecycle hooks run it.
After editing registrations during a watch session, rerun the generator and
restart/rebuild the browser bundle so the manifest and embedded hash stay aligned.

Unit tests collect the real Angular registrations. A separate application
registration test compares their metadata to the generated manifest. The generated
`viewer-contract.d.ts` supplies test/client types without a manually maintained
inventory. Browser tests validate responses against the manifest shipped with the
tested bundle; their Node process imports no controller implementations. Other
tests verify models can be injected independently of controllers and catalog
collection executes no callbacks.

## Verification

Run from the erdblick root with matching native/WASM artifacts already available:

```sh
NG_BUILD_MAX_WORKERS=2 npm run test -- --watch=false
npm run lint
NG_BUILD_MAX_WORKERS=2 npm run build -- -c profiling
npm run generate:viewer-actions
```

The suite covers transaction rollback/reentrancy/origins, the actual Angular
composition, deployed config/storage keys, URL/snapshot membership, asynchronous
target lifetimes and common action/candidate dispatch. Browser tests use the
already-built bundle and a matching `MAPGET_BIN`:

```sh
EB_MAPGET_MCP_LOCAL=1 EB_MAPGET_CONFIG=test/mapget-native-grid.yaml \
  npm run test:integration -- --project='' --workers=1 \
  playwright/tests/state-owner-actions.spec.ts playwright/tests/owner-omnibar.spec.ts
```

The cost of this architecture is explicit coordination. Multi-slot consumers must
choose completed projections; synchronous transactions do not roll back network
or renderer effects. URL dictionary coordination still has a dedicated owner.
The benefit of the model/controller split is a smaller dependency surface for
state consumers, without replacing AppState's existing subscription/codec model.

## Stored-state inventory

Release baseline: `6f5ba2fd6d6cb3810cd9bf4c305e0d5b229f4ef8`. The actual owner startup test in `app/mapview/view-identity.spec.ts` checks every frozen deployed key, including local-only preferences. The `styleOptions` registration retains compact option keys through its explicit storage/config/snapshot paths.

| Owner file | Stored keys |
| --- | --- |
| `app/coordinates/coordinates.model.ts` | `coordinatesEnabled`, `coordinatesLegalTermsAccepted`, `marker`, `markedPosition`, `enabledCoordsTileIds` |
| `app/rendering/rendering.model.ts` | `deckAntialiasingEnabled`, `semanticCompositingEnabled`, `contactShadingEnabled`, `lod3TileThreshold`, `tileSubsetRenderWorkerCount`, `pointCloudDownsamplingEnabled`, `pointCloudDetailPixels`, `pointCloudWorkingMemoryMiB`, `pointCloudGpuMemoryMiB`, `tilesLoadLimit` |
| `app/mapview/mapview.model.ts` | `viewIds`, `numberOfViews`, `focus`, `viewSync`, `cameraView`, `mode2d`, `mapZoomStep`, `featureZoomClearanceMeters`, `background`, `tileBorders`, `tileGridMode`, `tileGridLevel`, `tileGridAutoLevel`, `tileGridColor`, `tileGridOpacity` |
| `app/mapdata/mapdata.model.ts` | `layerSyncOptions`, `layerNames`, `visibility`, `zoomLevel`, `autoZoomLevel`, `styleOptions`, `stylePresetSelection`, `mapPresetSelection` |
| `app/connection/connection.model.ts` | `tilePullCompressionEnabled`, `connectionRetryEnabled`, `connectionRetryInitialDelayMs`, `connectionRetryBackoffMultiplier`, `connectionRetryMaxDelayMs` |
| `app/layout/layout.model.ts` | `mapsOpenState`, `dockOpenState`, `dockWidth`, `viewPanelSizes`, `dockActiveTabState`, `dockAutoCollapse`, `dialogLayouts` |
| `app/map-styles/map-styles.model.ts` | `styleVisiblity`, `styleEditorTarget` |
| `app/diagnostics/diagnostics.model.ts` | `diagnosticsLogFilter`, `diagnosticsExportOptions` |
| `app/config/config.model.ts` | `distributionVersions`, `erdblickVersion` |
| `app/inspection/inspection.model.ts` | `selected`, `inspectionsLimitState`, `drillPickRadius`, `inspectionTreeExpandByDefault`, `sourceDataInspectionDefaultColumns`, `inspectionTreeHiddenColumns`, `inspectionValueVaryColors`, `inspectionValueVaryOutlines`, `inspectionValueVaryStriping`, `hoverLabelsEnabled`, `hoverLabelFields`, `inspectionComparisonState` |
| `app/location-search/location-search.model.ts` | `locationSearchResultLimit` |
| `app/feature-search/feature-search.model.ts` | `featureSearchGrouping`, `featureSearchState` |
| `app/omnibar/omnibar.model.ts` | `searchHistory` |

There are 72 registrations: the 70 release AppState keys, `viewIds`, and the
existing `searchHistory` key formerly persisted by the omnibar component. History
retains legacy tuple decoding and JSON payload types, and stays outside URL and
snapshot sharing. `numberOfViews` is a projection of ordered IDs; `focus` stores a logical ID with the old numeric codec. The deployed spelling `styleVisiblity` is retained for compatibility.

### Method migration

| Former AppState behavior | Current owner |
| --- | --- |
| View count, camera, projection, sync, background and grid edits | `MapViewModel`; renderer workflows in `MapViewService` |
| Layer defaults, aligned arrays, option writes and preset selections | `MapDataModel`; catalog/preset coordination in `MapInfoService` |
| Feature/source selection, panel locking/focus/colors, comparison and cleanup | `InspectionPanelService`; async work in `InspectionSelectionService` |
| Search definitions and grouping | `FeatureSearchModel`; runtime work in `FeatureSearchService` |
| Style visibility and editor preference | `MapStylesModel`; document operations in `StyleService` |
| Marker/coordinate preferences and policy | `CoordinatesService`, `CoordinatesPolicyService` |
| Rendering and connection preferences | `RenderPreferencesService`, `ConnectionPreferencesService` |
| Generic dialog/dock/split layout | `AppLayoutService` |
| Version, diagnostics and location preferences | `AppConfigService`, `DiagnosticsFacadeService`, `LocationSearchService` |
| Shared v1/v2 layer/style/selection URL dictionary | `AppUrlStateService` |
| Generic storage/config ownership, validation, batching, snapshots and navigation persistence | `AppStateService` |

AppState values and codecs live in models; workflow methods live in controllers. There is no forwarding domain facade on `AppStateService`. Public action/control schemas and bindings are inline in their controller registration methods.

Raw line counts include moved code, formatting and comments and should not be treated as a complexity metric. The independent implementation comparison records separate production, infrastructure, test and generated-artifact changes.
