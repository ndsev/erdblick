# Service-owned application state

This experiment moves durable values and their operations to their domain owners.
`AppStateService` registers `AppState`, `MapViewState` and `StyleState` instances and
coordinates storage, config ownership, hydration and publication. It has no camera,
layer, inspection, search or preference operations.

## Owners and startup

The application initializer explicitly constructs every durable owner before config
seeding and hydration, installs `AppUrlStateService`, then seals registration.
Duplicate keys and late registration fail at the registration site. A frozen test
inventory checks compatibility with all 70 deployed storage slots, plus `viewIds`;
new slots do not require a second production string list.

`MapViewStateService` owns membership, committed cameras, projection, synchronization
and background/grid preferences. `MapViewService` owns renderers, camera previews,
view visualization and the removal workflow. `MapLayerStateService` owns layer
configuration, option values, presets and catalog pruning. It participates in view
membership changes through explicit callbacks; it does not inject the renderer
owner. The resulting dependency path is `MapViewService` → `MapInfoService` →
`MapLayerStateService` → `MapViewStateService`. The durable view owner never injects
`MapInfoService` or `MapLayerStateService`, avoiding the reverse path.

`InspectionStateService` owns panel selection, focus, locking, colors, comparison
references and layout cleanup. `InspectionSelectionService` consumes it to load
features and own asynchronous selection work. Search definitions belong to
`FeatureSearchService`; style UI values belong to `StyleService`; the remaining
preferences belong to layout, coordinates, rendering, connection, diagnostics,
location search and config services.

## Publication contract

A synchronous `transaction()` stages all touched values and restores their original
references if an edit throws. It compares only touched values, suppresses net-no-op
publications and retains original references for equal final values. It does not
copy unrelated application state.

A slot subscription receives that slot's current value immediately, including a
staged value if subscribed inside an edit. Slot observers run after all explicit
changes have been staged. `combineLatest` over individual slots cannot provide a
coherent multi-slot snapshot, since it caches their separate notifications.
Consumers that need membership, focus and other domains together use
`AppStateService.observe(() => projection)`. It emits after slot-derived edits
finish. Writes requested by these completed-state observers are queued until all
observers have seen the current commit, including a whole owner transaction. A new
completed observer installed during a transaction waits for commit or rollback.

## View identity and compatibility

Ordered `ViewId`s are authoritative membership. The old `numberOfViews` key is a
codec projection, and the old numeric `focus` key encodes an internally stored ID.
Per-view cameras, layers and style options use keyed dictionaries. Their deployed
storage and URL codecs remain positional. Search definitions refer to live IDs and
project their old selected-view indices at storage and UI boundaries. Added views
inherit search membership from their source view; removal prunes retired IDs.
Splitter proportions remain a positional layout preference.

Share links include ordered IDs in `vid`. IDs contain 1–64 ASCII letters, digits,
underscores or hyphens; Object.prototype property names are reserved. There must be
1–32 unique IDs and their count must agree with `n`. Repeated `vid` parameters and
explicit malformed IDs are rejected before mutation. A legacy link without IDs
gets one mapping before every positional importer runs. Omitted values in partial
links preserve saved cameras, layers and options through that mapping.

Renderer registrations add a lifetime generation to the logical ID. Removal and
restoration of the same URL ID cannot revive an old asynchronous target. Feature
focus captures targets before loading and resolves their current indices only at
commit; an unspecified target still means every matching visible view, with the
captured focused view as fallback.

## Checkpoint validation

The owner migration checkpoint passes the standard Angular runner with 180 tests
in `app-state-publication.spec.ts`, `app-state.spec.ts`, `appstate.service.spec.ts`,
`render-preferences.service.spec.ts` and `view-identity.spec.ts`. The runner compiles
all application and specification TypeScript. Full-suite runtime adaptation,
owner-registered actions/controls, browser verification and final production/lint
gates remain work in progress at this checkpoint.
