# Application state, controllers and actions

The application keeps its existing `AppState<T>`, `PerViewState<T>` and
`StyleState` abstractions. Each domain now has an injectable **state container** containing
its values, persistence declarations and state-only projections. A **controller**
uses those values to perform workflows and contributes its actions and controls.
`AppStateService` coordinates persistence and completed observations across containers.

This separates state access from runtime dependencies. Reading dock preferences
should not construct the dialog controller; reading search definitions should not
construct the search engine, map catalog or renderer.

The [structure workshop follow-up](erdblick-structure-followup.md) records the
folder/naming decisions and the proposed next splits of the large rendering and
search owners.

## Where to look

| Folder | Contents |
| --- | --- |
| `app/appstate/` | AppState primitives, publication, storage/config ownership, URL coordination and codecs |
| `app/layout/` | Main bar, dock/dialog/panel components, layout state and layout controller |
| `app/config/` | Composed deployment configuration, loading, precedence, publication and the About dialog; no state container |
| `app/preferences/` | Preference dialogs editing the owning domains through their normal controllers |
| `app/action/` | Action registry, MCP adapters and UI automation |
| `app/omnibar/` | Command palette, history compatibility codecs and `OmnibarState` |
| `app/navigation/` | Coordinate/feature jumps, location navigation and external viewers |
| `app/search/` | Feature-search definitions, execution, completion, result presentation and `SearchState` |
| `app/geolocation/` | Place providers, location geometry, consent UI and `GeolocationState` |
| `app/mapview/`, `app/mapdata/`, `app/inspection/`, `app/coordinates/`, `app/mapstyle/`, `app/diagnostics/` | The corresponding domain's state, controllers and presentation |
| `app/alert/`, `app/editor/`, `app/clipboard/`, `app/keyboard/` | Reusable UI capabilities, each with its own components/services |
| `app/survey/` | Configured announcement banner, its value contracts and HTML validation |
| `app/utils/` | Domain-independent reusable mechanisms shared across domains; no controllers or UI components |
| `app/scss/` | Application CSS; map-feature style documents belong to `app/mapstyle/` |

Each domain owning shared application state has one `<domain>.state.ts`, containing
its injectable `<Domain>State`. Multiple controllers may use that same container.
For example, `MapViewService` edits `MapViewState`, while renderers and workers
observe that container directly. Compression and retry preferences live in
`MapDataState`; `MapDataService` validates coordinated edits and contributes their
controls. Preference dialogs and deployment configuration supply values, but do
not own the behavior those values control.

Use `.model.ts` for domain value models, such as background layers, retry policies
and retained point-cloud input budgets. Use `.util.ts` for reusable operations and
mechanisms, including caller-managed queues, timers and cleanup. Domain-specific
utilities stay beside their domain; shared domain-independent mechanisms belong
in `utils/`. See [Source roles and dependencies](erdblick-source-structure.md) for
the precise boundaries and mechanical checks. Shared public contracts stay with
their values. `appconfig.model.ts` composes domain contracts from mapview,
geolocation, navigation, mapstyle and coordinates without importing their controllers. Infrastructure/stateless domains
do not acquire empty state containers or speculative `types/` directories.

State containers have no runtime dependency on controllers. State normalization, positional
compatibility codecs and membership invariants stay with the values they protect.
Network, renderer, worker and UI workflows stay in controller services. For example,
`MapViewState` keeps logical membership and per-view records coherent during URL
hydration, before renderers exist. Components retain private interaction details
such as caret position and pointer capture.

The main service boundaries are:

| Owner | Responsibility |
| --- | --- |
| `MapViewState` | Durable identities, committed cameras, projection/sync values, rendering budgets and GPU-management switch, positional codecs and coherent membership edits |
| `MapViewService` | Renderer lifetimes, live camera previews, navigation, view teardown and view/render-preference actions and controls |
| `MapDataState` | Layer values, style-option associations, preset selections, compression and retry preferences |
| `MapDataService` | Loaded catalog/tree, preset application, complete-catalog cleanup and transport-preference controls |
| `InspectionState` | Persisted selections, panel preferences, comparison data and codecs |
| `InspectionPanelService` | Panel lifetime, focus, locks, comparison and layout workflows |
| `InspectionSelectionService` | Asynchronous feature loading, selection projection and navigation |
| `SearchState` | Saved definitions, grouping and logical view associations |
| `SearchService` | Live sessions, completion, worker/transport coordination and search actions |
| `GeolocationState` | Location-search availability, result limits and local-only, revisioned boundary consent |
| `LocationPolicyService` | Explicit consent, refusal and read-only access to the bundled disclaimer |
| `AppActionRegistry` | Shared registration, schema validation and dispatch for omnibar and MCP |
| `DiagnosticsState` | Saved diagnostics preferences and read-only runtime version snapshots, kept outside persistence |
| `AppConfigService` | Configuration loading, precedence and publication, using pure domain schemas and normalizers |
| `McpActionService` | Connection registration, admission, deadlines, cancellation and Angular scheduling |
| `UiAutomationService` | Bounded DOM snapshot identities, resizing, interaction and screenshots |

`AppActionRegistry` and `McpActionService` have separate lifetimes and responsibilities:
the omnibar uses the registry even when MCP is disabled. The transport adapter has
no domain dispatch switch or separate action catalog. Likewise, `MapViewState`
works without renderer construction, while `MapViewService` owns the live resources
that must be retired before a view disappears.

## Declaring and observing state

`CoordinatesState` keeps the deployed key and URL codec next to the value:

```ts
readonly markerState = this.persistence.registerState<boolean>({
    name: "marker",
    defaultValue: false,
    schema: Boolish,
    urlParamName: "m",
    urlIncludeInVisualizationOnly: false
});
```

A component which only observes state injects the state container directly:

```ts
constructor(readonly layout: LayoutState) {
    this.subscription = layout.dockOpenState.subscribe(open => {
        // Update this component's presentation from the current dock preference.
        this.dockVisible = open;
    });
}
```

As with the existing AppState system, the consumer releases its subscription when
it is destroyed. Controllers inject their state containers as readonly dependencies, usually
named `state`. A consumer that also invokes a controller can use that same instance
through, for example, `coordinatesService.state`; state is neither copied nor
forwarded through getters.

For a coherent observation spanning several slots, use a completed projection:

```ts
persistence.observe(() => ({
    enabled: coordinates.markerState.value,
    position: coordinates.markedPositionState.value
}), deepEquals).subscribe(marker => updateMarkerOverlay(marker));
```

`updateMarkerOverlay` denotes the consumer's rendering work. The state container does not
perform rendering. `CoordinatesService.setMarker()` batches the position and
visibility changes in the ordinary AppState transaction.

`observe()` is a completed-edit notification, not a reactive dependency tracker.
It runs the reader on every commit and compares its result with the previous one.
Use `Object.is` (the default) for a scalar or existing reference; use `deepEquals`
for a freshly constructed record such as the marker above. Keep the reader cheap
and free of effects. Unlike `combineLatest`, it cannot cache a new visibility value
alongside a position notification from the previous edit.

## Controller registration

A **control** is an explicit public value reader/writer. It may combine several
stored slots or describe runtime state. An **action** is a semantic operation,
such as closing a particular inspection or starting a search. Neither name is a
persistence key, and state containers are not automatically exposed to MCP.

Controllers implement `AppActionContributor`. Its two optional methods distinguish
operations from controls without requiring empty implementations. They accept the
narrow `AppActionRegistration` contract implemented by `AppActionRegistry`, so
declaring operations does not require importing the dispatch service:

```ts
registerActions(actions: AppActionRegistration): void {
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
marker control and [MapViewService](../app/mapview/mapview.service.ts) for scoped
camera/layer controls. Shared validators remain named when other operations use
them, such as camera validation, feature references and search settings.
There are no `.declarations.ts` companions or exported declaration maps.

A choice such as `Close Road.17` carries a panel ID and captured lifetime. The
handler checks the lifetime before acting. MCP obtains the same identity through
`app.selections`. There is no unparameterized, ambiguous “close inspection” menu
entry. Local-only operations declare `exposure: "omnibar"`; candidate production
is never executed during catalog collection.

`registerApplication()` is the single composition point for controller instances.
It constructs their state containers and the independently owned omnibar state, seals
persistence registration, and passes the
controllers to `AppActionRegistry.registerContributors()`. All controls register
first, then operations; the registry derives `viewer_describe_controls`,
`viewer_get_controls` and `viewer_set_control` from those registered controls.
Duplicate and late registrations fail. There is no second production list of
expected declarations to keep aligned.

This explicit list is intentional. `providedIn: "root"` makes a service available
for injection; it does not instantiate every owner before persistence hydration.
An Angular multi-provider would still require an explicit provider inventory and
an eager initialization step. Keeping one composition function makes that ordering
visible and lets browser startup and the Node collector share the exact same list.
If independently packaged plugins become necessary, multi-providers could become
useful; they currently add another registration layer without removing a list.

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

`npm run lint` enforces `erdblick/no-combine-app-state`. It recognizes raw AppState
inputs to RxJS `combineLatest` and `combineLatestWith`, including imported aliases,
local input collections, and direct `pipe()`/`asObservable()` wrappers. Read their
state through `observe()` first. It still allows combining a completed projection
with independent runtime streams such as incoming diagnostics logs or a local sort
order. This is a typed lint guard, not whole-program data-flow analysis: arbitrary
factory functions or getters returning disguised streams still need review.

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

`viewer_get_share_link` returns `window.location.href`, preserving the current
route, query parameters (including repeated/unknown parameters) and fragment. It
does not serialize state, navigate, or flush a pending URL update. Copying therefore
matches the address currently visible in the browser. Normal hydration, pruning
and address-bar synchronization retain their codecs; those are still needed when
state changes or a link is opened. The action separately reports dependencies on
browser-local styles/searches that a URL cannot carry.

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
tests verify state containers can be injected independently of controllers and catalog
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
EB_MAPGET_MCP_LOCAL=1 EB_MAPGET_CONFIG=tests/playwright/fixtures/mapget-native-grid.yaml \
  npm run test:integration -- --project='' --workers=1 \
  tests/playwright/tests/state-owner-actions.spec.ts tests/playwright/tests/owner-omnibar.spec.ts
```

The cost of this architecture is explicit coordination. Multi-slot consumers must
choose completed projections; synchronous transactions do not roll back network
or renderer effects. URL dictionary coordination still has a dedicated owner.
The benefit of the state/controller split is a smaller dependency surface for
state consumers, without replacing AppState's existing subscription/codec model.

## Stored-state inventory

Release baseline: `6f5ba2fd6d6cb3810cd9bf4c305e0d5b229f4ef8`. The actual owner startup test in `tests/app/mapview/view-identity.spec.ts` checks every frozen deployed key, including local-only preferences. The `styleOptions` registration retains compact option keys through its explicit storage/config/snapshot paths.

| Owner file | Stored keys |
| --- | --- |
| `app/coordinates/coordinates.state.ts` | `coordinatesEnabled`, `coordinatesLegalTermsAccepted`, `marker`, `markedPosition`, `enabledCoordsTileIds` |
| `app/mapview/mapview.state.ts` (rendering) | `deckAntialiasingEnabled`, `semanticCompositingEnabled`, `contactShadingEnabled`, `lod3TileThreshold`, `tileSubsetRenderWorkerCount`, `pointCloudDownsamplingEnabled`, `pointCloudDetailPixels`, `pointCloudWorkingMemoryMiB`, `pointCloudGpuMemoryMiB`, `tilesLoadLimit` |
| `app/mapview/mapview.state.ts` (views) | `viewIds`, `numberOfViews`, `focus`, `viewSync`, `cameraView`, `mode2d`, `mapZoomStep`, `featureZoomClearanceMeters`, `background`, `tileBorders`, `tileGridMode`, `tileGridLevel`, `tileGridAutoLevel`, `tileGridColor`, `tileGridOpacity` |
| `app/mapdata/mapdata.state.ts` | `layerSyncOptions`, `layerNames`, `visibility`, `zoomLevel`, `autoZoomLevel`, `styleOptions`, `stylePresetSelection`, `mapPresetSelection` |
| `app/layout/layout.state.ts` | `mapsOpenState`, `dockOpenState`, `dockWidth`, `viewPanelSizes`, `dockActiveTabState`, `dockAutoCollapse`, `dialogLayouts` |
| `app/mapstyle/mapstyle.state.ts` | `styleVisiblity`, `styleEditorTarget` |
| `app/diagnostics/diagnostics.state.ts` | `diagnosticsLogFilter`, `diagnosticsExportOptions` |
| `app/mapdata/mapdata.state.ts` (transport) | `tilePullCompressionEnabled`, `connectionRetryEnabled`, `connectionRetryInitialDelayMs`, `connectionRetryBackoffMultiplier`, `connectionRetryMaxDelayMs` |
| `app/inspection/inspection.state.ts` | `selected`, `inspectionsLimitState`, `drillPickRadius`, `inspectionTreeExpandByDefault`, `sourceDataInspectionDefaultColumns`, `inspectionTreeHiddenColumns`, `inspectionValueVaryColors`, `inspectionValueVaryOutlines`, `inspectionValueVaryStriping`, `hoverLabelsEnabled`, `hoverLabelFields`, `inspectionComparisonState` |
| `app/geolocation/geolocation.state.ts` | `locationSearchResultLimit` |
| `app/search/search.state.ts` | `featureSearchGrouping`, `featureSearchState` |
| `app/omnibar/omnibar.state.ts` | `searchHistory` |

There are 70 registrations: the 68 release preference keys, `viewIds`, and the
existing `searchHistory` key formerly persisted by the omnibar component.
`distributionVersions` and `erdblickVersion` now describe the running deployment
through `DiagnosticsState.versions` / `versions$`; they are never restored or
exported as preferences. Old snapshots and config defaults can still contain
these keys: import ignores them and retains the remaining user settings. History retains legacy tuple decoding and JSON payload types, and stays outside URL and
snapshot sharing. `numberOfViews` is a projection of ordered IDs; `focus` stores a logical ID with the old numeric codec. The deployed spelling `styleVisiblity` is retained for compatibility.

### Method migration

| Former AppState behavior | Current owner |
| --- | --- |
| View count, camera, projection, sync, background and grid edits | `MapViewState`; renderer workflows in `MapViewService` |
| Layer defaults, aligned arrays, option writes and preset selections | `MapDataState`; catalog/preset coordination in `MapDataService` |
| Feature/source selection, panel locking/focus/colors, comparison and cleanup | `InspectionPanelService`; async work in `InspectionSelectionService` |
| Search definitions and grouping | `SearchState`; runtime work in `SearchService` |
| Style visibility and editor preference | `MapStyleState`; document operations in `MapStyleService` |
| Marker/coordinate preferences and policy | `CoordinatesService`, `CoordinatesPolicyService` |
| Rendering preferences | `MapViewState`; coordinated writes and controls in `MapViewService` |
| Connection preferences | `MapDataState`; coordinated writes and controls in `MapDataService` |
| Generic dialog/dock/split layout | `LayoutService` |
| Version, diagnostics and location preferences | `AppConfigService`, `DiagnosticsFacadeService`, `GeolocationService` |
| Shared v1/v2 layer/style/selection URL dictionary | `AppUrlStateService` |
| Generic storage/config ownership, validation, batching, snapshots and navigation persistence | `AppStateService` |

AppState values and codecs live in state containers; workflow methods live in controllers. There is no forwarding domain facade on `AppStateService`. Public action/control schemas and bindings are inline in their controller registration methods.

Raw line counts include moved code, formatting and comments and should not be treated as a complexity metric. The independent implementation comparison records separate production, infrastructure, test and generated-artifact changes.
