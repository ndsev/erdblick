# Structure workshop: decisions and next extractions

This records the October 26 workshop and October 27 ownership follow-up against the lazyape implementation
at `7fad0e8d`. Concrete moves, naming changes and the small cleanups below are
implemented. The three large-file decompositions are **proposals for review**;
the workshop explicitly deferred their implementation.

## Applied conventions

| Concern | Convention and consequence |
| --- | --- |
| Shared application state | One `<domain>.state.ts` container per state-owning domain, named `<Domain>State`; controller access is `controller.state`. No empty containers for stateless domains. |
| Domain values | `.model.ts` describes values or a runtime model with its own invariants. Background layers, retry policy and point-cloud input admission are examples. |
| Public contracts | Keep schemas and public shapes beside their owning values. Domain schemas and normalization live with their consumers; `appconfig.model.ts` only composes the configuration envelope. Type-only consumers avoid importing controllers. |
| Helpers | Use `.util.ts` for reusable operations and mechanisms, including classes with caller-managed state and cleanup. Keep domain helpers in that domain; put domain-independent helpers shared across domains in `utils/`. Inline trivial single-consumer wrappers. |
| Folders | Name a capability or responsibility. `search/`, `geolocation/`, `mapstyle/` and `scss/` replace the overlapping older names. Alerts, clipboard, keyboard and editor now have explicit homes. |
| Comments | Explain ownership, ordering, invariants and user-visible effects. A comment that only restates a method name does not explain a publication or persistence protocol. |
| State observation | Subscribe directly to one slot. Use `AppStateService.observe()` when related values must be sampled after the whole edit. The typed lint rule rejects raw AppState inputs to RxJS combination operators. |
| Compatibility | File/class names may change freely; deployed URL, storage, config and snapshot keys retain their compatibility codecs. |

The follow-up removes `ConfigState` and both preference-only controllers.
Rendering/resource preferences now belong to `MapViewState`, with coordinated
writes and controls in `MapViewService`. Compression and retry preferences belong
to `MapDataState`, with writes and controls in `MapDataService`. These are the
existing behavior owners, so passive consumers still inject only the state.
`rendering/` has been dissolved; `preferences/` contains the preference dialogs.

`AppConfigService` now only loads, merges and publishes configuration. It has no
AppState dependency or action registration. Pure domain models own backgrounds,
provider adapters, external viewers, stylesheet bundles, coordinate terms and
survey validation. The config envelope imports those models without constructing
any controller. Background discovery is a mapview action.

Version labels are read-only runtime snapshots in `DiagnosticsState`, separate
from persisted diagnostic preferences. Old version keys in snapshots/config are
ignored so the remaining preferences still import. Every deployed preference,
config and URL key is unchanged.

## Answers to the individual architectural notes

**Action contract barrel.** `viewer-action.contract.ts` mostly re-exported other
owners and also contained canonical JSON serialization. Runtime consumers now
import their actual definitions directly. The canonical function is in
`action/catalog-json.util.ts`, shared by the Node exporter and contract parity
tests. There is no second action declaration catalog in this file.

**Coordinate frame helper.** The one-consumer wrapper was removed. The panel now
contains the `auditTime(0, animationFrameScheduler)` operator beside the display
update it schedules. Its test exercises the panel's actual coalescing and teardown.

**Point-cloud input budget.** This models the domain's retained immutable payloads
and eviction policy. It moved beside `FilterTileState`
in `mapdata/point-cloud-input-budget.model.ts`. Rendering supplies its working-memory
allowance. The fetched `origin/release/2026.5.0` still had the same budget
implementation at this review; no unverified upstream rewrite was substituted.

**Application registration.** Retain one explicit composition function, shared by
browser startup and the Angular-in-Node catalog collector. Angular root providers
are lazy; discovering a controller when its panel first opens would be too late
for hydration and initial tool discovery. Multi-providers would still need a
provider inventory and an eager initializer. Registration remains separate from
runtime initialization so catalog collection never starts a worker, fetch or socket.

**Share URL versus URL codecs.** Copying a link now returns the current browser
URL, including its route, unknown/repeated query parameters and fragment. It does
not rebuild state or force a pending URL write. Normal URL parsing, pruning and
writing still need the existing codecs and domain coordinator. Removing those
would break restoration and ordinary state-to-address synchronization.

**Publication mechanics.** The service now explains staging, nested rollback,
derived slot writes, the completed observation, deferred observer writes, config
ownership and persistence scheduling separately. A completed observation has no
automatic dependency tracking: its cheap reader runs on each commit, then equality
suppresses unchanged results. The unnecessary numeric commit counter is removed.
The reader's errors terminate its own subscription without blocking other readers.


## October 27 naming and ownership pass

The infrastructure folders are `appstate`, `action` and `config`.
Domain controllers use `mapview.service.ts`, `mapdata.service.ts`,
`mapstyle.service.ts`, `search.service.ts`, `geolocation.service.ts` and
`layout.service.ts`. Specialized controllers retain their descriptive names.
Words in filenames use hyphens; dots separate roles such as `.component.ts`.

The generic per-view AppState helper is now `PerViewState<T>`, so it cannot be
confused with the domain's injectable `MapViewState`. `AppState<T>` and
`StyleState` keep their existing subscription and codec behavior. Value records
such as `mapview.model.ts`, `inspection.model.ts` and
`search-definition.model.ts` are distinct from injectable `.state.ts` containers.

Policy placement follows meaning: the integer style LOD ladder belongs to
mapstyle; camera-density thresholds and GPU interpolation belong to mapview.
The one-shot inspection partition cap belongs to the transport controller and
is independent of the user's visible-tile preference.

Browser startup and the Angular-in-Node catalog build still call the same explicit
composition root. No declaration files or secondary discovery mechanism were
introduced. The generated catalog remains identical: 32 actions and 21 controls.

The subsequent tree review removes `auxiliaries/`. Keyboard help lives beside
the keyboard service; the survey banner and its value contract live together in
`survey/`. Datasource editing, cache reset and map copyright notices belong to
`mapdata/`. The About dialog lives in `config/` and reads runtime version metadata
from `DiagnosticsState`.

The shortened `action/` folder contains `action-registry.service.ts`,
`action-contributor.model.ts`, `action.model.ts` and `control-actions.util.ts`.
The model files describe public contracts; the utility derives generic control
schemas from the actual registrations. Controller declarations remain beside
their execution callbacks. `config/` retains the descriptive `appconfig` and
`appmode` filenames. Mirrored specs under `tests/app/` follow these moves; catalog
generation and packaged-asset paths follow `action/generated/`.

## Validation of the ownership and naming pass

All 1,395 Angular tests pass, including old preference keys, URL/view retention,
controller-free state observation, configuration loading, action registration and
runtime-version retirement. All 15 typed lint-rule tests pass. Application lint
has no errors and the same eight pre-existing file-length warnings. The full
profiling UI build and Angular-in-Node catalog generation pass; the generated
catalog is byte-for-byte unchanged (32 actions and 21 controls).

Three Firefox scenarios pass against native mapget: omnibar commands/history and
inspection closing; view identity, tab isolation, cameras and share links; and
presentation-state replacement. No native code changed or was rebuilt.

The shared review preserves the frozen source/metrics and existing discussions,
updates proposed paths, and includes the six newly extracted model files. All
272 active file nodes were checked against the current checkout (the icon remains
binary). The review tool has 34 passing tests, including newly added file source
reads and preservation of notes across moves. Reload the review page once for the
updated client; use **Current working tree** for implementation source.

The worktree's Graphify index was refreshed. Its AST extractor reports 5,675
edges with unresolved endpoints; graph queries are an index, not proof of a
complete dependency graph. Ownership conclusions were verified against source
and tests.

## Proposal: `mapview/deck/deck-view.ts`

The current file has **4,446 physical lines**. It implements `IRenderView`, but also
owns several independently scheduled overlay and input workflows. Keep one
`DeckMapView` as the renderer lifetime owner. Extract collaborators whose state and
cleanup move together; do not create root Angular services for objects belonging
to one canvas.

| Candidate | Existing responsibilities to move | Boundary and lifetime |
| --- | --- | --- |
| `DeckBackground` in `deck-background.ts` | `updateBackgroundLayer`, XYZ/WMS creation, fetch/load options, signature and layer removal | Per view; receives normalized background config and a layer registry. No `AppConfigService` dependency in the collaborator. |
| `DeckSearchOverlay` in `deck-search-overlay.ts` | Search overlay scheduling, density layout, pin creation, source keys and layer removal | Per view; receives search overlay values plus current viewport/visibility decisions. Owns its pending refresh and registered overlay IDs. |
| `DeckTileOverlay` in `deck-tile-overlay.ts` | Grid refresh, tile-state overlays, outline data/geometry and visible layer levels | Per view; receives tile/grid snapshots and viewport. Keeps grid geometry and refresh cancellation together. Reuses the existing tile-grid layer implementation. |
| `DeckLocationOverlay` in `deck-location-overlay.ts` | Marker, location/jump-area highlights, label timers and removal | Per view; takes geographic values and style inputs. Does not own camera navigation or search sessions. |
| `DeckPicking` in `deck-picking.ts` | Eligible pick layers, rendered order, feature-ID decoding, navigation anchors, hover queues and generations | Per view; accepts a narrow picking surface and publishes typed hover/click results. Inspection and coordinate controllers remain at the renderer's application boundary. |

The overlay region from background creation through grid/outline geometry is
roughly **1,290 lines**, including location-highlight code and comments. Picking
and hover/click regions contribute roughly **720 more**. These are current source
regions, not promised net reductions: imports, fields and lifecycle contracts also
move, and some navigation/geometry methods may remain shared with the renderer.

Keep Deck/device creation, context loss, render invalidation, scene attachment,
canvas sizing and final destruction in `DeckMapView`. Its teardown currently
retires scene buffers and atlases before releasing the device. Each collaborator
must cancel work and remove its layers before the registry/device are destroyed.
It must never look up a replacement canvas by DOM ID during teardown.

Camera state and first-person transitions are a later extraction. They span
`setViewFromState`, live preview, committed AppState publication, controller target
acquisition and view-removal flushing. Moving those first would produce a large
callback interface and obscure the lifetime contract. Finish the overlay/picking
boundaries, then reassess what remains; do not target an arbitrary LOC ceiling.

Dependencies improve when an overlay consumes data rather than importing
`SearchService`, `InspectionPanelService` or `AppConfigService`. They worsen if
every extracted class receives the entire `DeckMapView` or a generic service bag.
Small existing types such as `RenderNavigationTarget` remain with `render-view.ts`;
private collaborator types stay in their files, not a new shared types directory.

Validate each extraction against existing picking, navigation-target, tile-grid,
density, camera-sync and renderer teardown tests, plus browser view replacement.
Move relevant tests with the behavior. Preserve generation checks, cancellation,
frame coalescing and device destruction order explicitly.

## Proposal: `search/search.component.ts`

The current file has **4,292 physical lines**, including roughly **570 lines of
inline template**. It combines a dialog/dock shell with scope selection, style
editing, diagnostics and incremental result-tree construction. These are user-facing
sections with distinct local state, which are better seams than utility files.

| Candidate | State and behavior that move together |
| --- | --- |
| `search-scope.component.ts` | Map/layer tree selection, inferred attribute scope, feature-type/tile-level/view selectors and their drafts. The main selector block alone is about 700 lines. |
| `search-style.component.ts` | Rule drafts, field metadata, auto-rule initialization, render-strategy options, apply/save workflow and the Style tab template. Reuse the existing rule/color editors and stylesheet converter. |
| `search-results.component.ts` | PrimeNG tree, incremental append cursor, grouping, expanded nodes, frame scheduling and resize observer. The tree-building tail is about 470 lines, plus its owned fields/template. |
| `search-diagnostics.component.ts` | Diagnostics presentation, progress display scheduling and value-summary labels/histograms. It requests summaries through the search controller, rather than owning summary computation. |

Keep the outer component responsible for selecting the session, query editing,
docking/dialog visibility, header actions, confirmation on close and exports.
Children take an explicit session identity and read-only current values; emit
semantic edits such as selected layers or a committed rule set. An output should
not forward every input event up several layers. A child may use the existing
search controller for a workflow it owns, but must not receive the parent component
as its API or mutate the runtime session directly.

Local drafts, expanded tree nodes, animation-frame handles and resize observers
stay local to these components. They are not new AppStates and do not need new
singleton containers. Persisted definitions remain in `SearchState`. The result
tree must preserve chunked append and cancellation so splitting templates does not
regress responsiveness while tiles stream in.

Extract result-tree ownership first, then scope selection, then the Style tab.
That gives the largest reduction in unrelated imports without moving all complex
behavior at once. Keep a component's private types next to it. Introduce subfolders
only when these sections actually have multiple associated files; no empty
`types/` or generic `components/` hierarchy is needed in advance.

Validate grouping/order and cancellation, source selection, style initialization
and save, async dialog rendering, and dock/close behavior through the existing
search unit tests and browser search/omnibar scenarios.

## Proposal: `search/search.service.ts`

The current file has **4,553 physical lines**. Persisted definitions have already
moved to `SearchState`; the remaining weight is primarily runtime work. Moving more
fields into that state container would hide worker, session and rendering lifetimes.

| Candidate | Existing code and ownership |
| --- | --- |
| `SearchCompletionService` | Owner-specific completion state, timers, worker requests/replies, request IDs, merging and cancellation (about 205 method lines plus fields). Own the worker lifecycle; defer startup so Node catalog collection remains free of IO. Extend/reuse `FeatureSearchSchemaService` only if the worker lifetime truly belongs there after inspection. |
| `SearchResults` in `search-results.model.ts` | Per-session tile contributions, append/rebuild cursor, result-point buckets, generation, ingress progress and density index. Own add/replace/remove/reset operations; reject contributions from retired runs. |
| Summary computation beside `SearchResults` | Normalize and merge value summaries, histograms and distinct counts; roughly 345 lines today. Pure aggregation can share the result model's module initially. Add a separate file only if it becomes an independently consumed contract. |
| `SearchPresentation` in `search-presentation.ts` | One session/layer presentation's styled layer, coverage, subscription, run identity and destruction. Current reconciliation/create/destroy/coverage spans roughly 620 lines. The controller owns the collection; each presentation owns its resource cleanup. |
| `search-session.model.ts` | Public session/result/completion value contracts currently exported from the controller. Consumers requiring only shapes use type-only imports; avoid moving private worker tasks here merely because they are interfaces. |

Keep `SearchService` as the application controller: create/clone/close a
search, reconcile saved definitions, coordinate layout and active presentations,
and implement `AppActionContributor`. Its inline `registerActions` and
`registerControls` stay beside the public operations they bind. Do not recreate
`.declarations.ts` companions or add a second MCP-specific search controller.

The result model must be independent of Angular, the map controller, the DOM and
MCP. It receives contributions and returns read-only results/progress. The
presentation owns the `StyledMapgetLayer` subscription and disposal; the outer
controller routes its events to the correct current results/run. Completion has
its own owner IDs and cancellation, so editing one query cannot cancel another's.

Prefer replacing existing data bags with these owners over adding wrappers around
unchanged service methods. Start with completion and result contracts, then result
ingestion, then presentation ownership. Do not build a framework of event buses,
generic task registries or one-method forwarding services.

Validation must retain stale-run rejection, subset replacement/removal, worker
completion isolation, budgeted incremental ingestion, progress completion, summary
limits, search closing, view membership pruning and catalog-only startup. Existing
tests already exercise many of these; strengthen the lifetime seams while moving
them instead of testing implementation-shaped forwarding methods.

## Acceptance criteria for the next round

Each extraction should reduce the dependencies needed by its consumers, move
cleanup with the resources it creates, and give a reviewer one coherent workflow
per owner. Shared state and action declarations keep their current registration
shape. No new legacy aliases or persistence-key migrations are required by these
source moves. Compare dependency direction and lifetime clarity alongside LOC;
total lines may grow slightly when formerly implicit contracts become documented.

## Suffix cleanup iteration (October 28)

Implemented the agreed role suffixes across 67 source filenames and 41 mirrored
spec filenames. Two helper/contract modules were merged into their domain
models. The earlier AppState-values model rename is retained. Deployed URL,
storage, configuration and MCP keys are unchanged.

The stable definitions and mechanical checks are in
[Source roles and dependencies](erdblick-source-structure.md).
`MapLayerTree` is a controller supplied by MapDataService; its construction and
lifetime stay intact. FrameBudgetLoop remains a utility with caller-managed
queues, scheduling and cleanup. Component cardinality does not impose identical
lifetimes or component-local construction.

The actual dependency boundaries required four small contract modules:

- `mapdata/source-catalog.model.ts`: datasource metadata and normalizers shared
  by MapgetLayer and the interactive tree.
- `mapdata/map-tile-stream.protocol.ts`: framing values, messages and transport
  snapshots, independent of the network clients.
- `mapdata/styled-mapget-layer.model.ts`: identity, filter-plan and event values,
  independent of the presentation opening the subscription.
- `mapview/view-layer-diagnostics.model.ts`: diagnostic snapshots, independent
  of the service reading live renderer values.

Shared style values now live in `mapstyle.model.ts`, search result/candidate
contracts in `search.model.ts`, and feature identity encoding beside its schema.
AppActionContributor takes the narrow AppActionRegistration contract, which the
registry implements. Action/control declarations and handlers remain inline in
the contributing services. MapDataState pruning consumes the identifiers it
needs without importing the map-tree controller.

The structural checker also found five pre-existing misleading suffixes: the
browser debug API becomes an adapter, and four manually managed renderer
helpers become visualizations. Their class names no longer imply Angular
services. Generic hashing moves into utils; coordinate precision stays in the
coordinates domain. New module comments explain those responsibilities.

### Validation and remaining review signals

- All 1,395 Angular tests across 132 files pass.
- All 25 lint/structure rule tests pass; TypeScript and ESLint pass.
- The full profiling frontend build passes with two build workers.
- Three Firefox scenarios against native mapget pass: owner omnibar commands,
  owner state controls and share links, and presentation state bridging.
- Source-role/dependency checking reports zero errors and 18 utility-reuse
  warnings. These are the explicitly advisory single-production-consumer cases;
  tests and re-export barrels do not count as reuse. ESLint retains its eight
  existing file-length warnings.
- The canonical action catalog hash is unchanged:
  `5defefeb452b0666728b1e4eb94a40f3054f5a2df770dbc22ec4d2606614b8a3`.
- Emitted runtime bodies are identical for 63 mechanically moved modules after
  normalizing intentional renderer symbol names and excluding imports. The four
  extraction/merge modules were reviewed separately and exercised by the suite.
- The shared review tree follows the implemented filenames and retains the
  original annotations and removed nodes. All 71 renamed or new file-source
  responses match their working-tree paths and content hashes. Snapshot LOC and
  consumer metrics remain frozen; select **Current working tree** for source.
- The workspace code graph was rebuilt for the new layout. The installed
  Graphify version still reports its existing skill/package version mismatch.

The full tests caught a path-rewrite mistake affecting dot-token decoding. The
original values were restored before the passing rerun; no URL codec behavior
change is part of this iteration.

The MapViewer documentation screenshot source inputs follow the transport
client/protocol split. Parent-repository changes remain uncommitted, as requested.

### Implemented source moves

Paths are relative to `app/`. Direct counterpart specs follow the same role
suffix under `tests/app/`; the merged feature-identity encoding tests retain a
focused name in the inspection test directory.

| Previous file | Current file |
| --- | --- |
| `app-debugapi.component.ts` | `app-debugapi.adapter.ts` |
| `appstate/appstate.ts` | `appstate/appstate.model.ts` |
| `appstate/url-state-codec.ts` | `appstate/url-state-codec.util.ts` |
| `diagnostics/diagnostics.perf-aggregation.ts` | `diagnostics/diagnostics-perf-aggregation.util.ts` |
| `editor/codemirror-theme.ts` | `editor/codemirror-theme.extension.ts` |
| `geolocation/location-geometry.ts` | `geolocation/location-geometry.util.ts` |
| `inspection/feature-identity.ts` | `inspection/feature-identity.model.ts` |
| `inspection/inspection-tree-highlight.ts` | `inspection/inspection-tree-highlight.util.ts` |
| `integrations/deckgl.ts` | `integrations/deckgl.adapter.ts` |
| `integrations/geo.ts` | `integrations/geo.adapter.ts` |
| `integrations/wasm.ts` | `integrations/wasm.adapter.ts` |
| `layout/app-dialog-resize.ts` | `layout/app-dialog-resize.util.ts` |
| `mapdata/feature-inspection.ts` | `mapdata/feature-inspection.adapter.ts` |
| `mapdata/filter-subscription.ts` | `mapdata/filter-subscription.model.ts` |
| `mapdata/filter-tile-state.ts` | `mapdata/filter-tile-state.model.ts` |
| `mapdata/map-layer-state.ts` | `mapdata/map-layer-state.model.ts` |
| `mapdata/map.tree.ts` | `mapdata/map-tree.controller.ts` |
| `mapdata/mapget-layer.ts` | `mapdata/mapget-layer.model.ts` |
| `mapdata/partition.ts` | `mapdata/partition.model.ts` |
| `mapdata/styled-mapget-layer.ts` | `mapdata/styled-mapget-layer.presentation.ts` |
| `mapdata/tile-diagnostics.ts` | `mapdata/tile-diagnostics.model.ts` |
| `mapdata/tile-expiry-scheduler.ts` | `mapdata/tile-expiry-scheduler.util.ts` |
| `mapdata/tilestream.ts` | `mapdata/map-tile-stream.client.ts` |
| `mapstyle/hash.ts` | `utils/hash.util.ts` |
| `mapstyle/layer-preset.ts` | `mapstyle/layer-preset.model.ts` |
| `mapstyle/map-preset.ts` | `mapstyle/map-preset.model.ts` |
| `mapstyle/style-validation.ts` | `mapstyle/style-validation.model.ts` |
| `mapview/deck/deck-contact-shading.service.ts` | `mapview/deck/deck-contact-shading.visualization.ts` |
| `mapview/deck/deck-first-person-navigation.ts` | `mapview/deck/deck-first-person-navigation.util.ts` |
| `mapview/deck/deck-interaction-effect.ts` | `mapview/deck/deck-interaction-effect.util.ts` |
| `mapview/deck/deck-interaction-outline.service.ts` | `mapview/deck/deck-interaction-outline.visualization.ts` |
| `mapview/deck/deck-layer-registry.ts` | `mapview/deck/deck-layer-registry.util.ts` |
| `mapview/deck/deck-location-area-navigation.ts` | `mapview/deck/deck-location-area-navigation.util.ts` |
| `mapview/deck/deck-navigation-target.ts` | `mapview/deck/deck-navigation-target.presentation.ts` |
| `mapview/deck/deck-planar-pan.ts` | `mapview/deck/deck-planar-pan.util.ts` |
| `mapview/deck/deck-semantic-z-index.service.ts` | `mapview/deck/deck-semantic-z-index.visualization.ts` |
| `mapview/deck/deck-subset-picking.ts` | `mapview/deck/deck-subset-picking.util.ts` |
| `mapview/deck/deck-tile-gltf-asset.ts` | `mapview/deck/deck-tile-gltf-asset.adapter.ts` |
| `mapview/deck/deck-view.ts` | `mapview/deck/deck-view.controller.ts` |
| `mapview/deck/deck-view2d.ts` | `mapview/deck/deck-view2d.controller.ts` |
| `mapview/deck/deck-view3d.ts` | `mapview/deck/deck-view3d.controller.ts` |
| `mapview/deck/deck-viewport-coverage.ts` | `mapview/deck/deck-viewport-coverage.util.ts` |
| `mapview/deck/gpu-icon-atlas.service.ts` | `mapview/deck/gpu-icon-atlas.visualization.ts` |
| `mapview/deck/gpu-memory-budget.ts` | `mapview/deck/gpu-memory-budget.model.ts` |
| `mapview/deck/gpu-primitive-store.ts` | `mapview/deck/gpu-primitive-store.util.ts` |
| `mapview/deck/gpu-range-allocator.ts` | `mapview/deck/gpu-range-allocator.model.ts` |
| `mapview/deck/gpu-render-packet.ts` | `mapview/deck/gpu-render-packet.model.ts` |
| `mapview/deck/gpu-scene.ts` | `mapview/deck/gpu-scene.visualization.ts` |
| `mapview/deck/location-outline-buffer.ts` | `mapview/deck/location-outline-buffer.util.ts` |
| `mapview/deck/navigation/erdblick-navigation-anchor.ts` | `mapview/deck/navigation/erdblick-navigation-anchor.util.ts` |
| `mapview/deck/navigation/erdblick-target-navigation-adapter.ts` | `mapview/deck/navigation/erdblick-target-navigation.adapter.ts` |
| `mapview/deck/navigation/feature-navigation.types.ts` | `mapview/deck/navigation/feature-navigation.model.ts` |
| `mapview/deck/navigation/web-mercator-feature-navigation.ts` | `mapview/deck/navigation/web-mercator-feature-navigation.adapter.ts` |
| `mapview/deck/tile-coordinate-origin.ts` | `mapview/deck/tile-coordinate-origin.util.ts` |
| `mapview/deck/tile-subset-gltf-presentation.ts` | `mapview/deck/tile-subset-gltf.presentation.ts` |
| `mapview/deck/tile-subset-interaction.ts` | `mapview/deck/tile-subset-interaction.model.ts` |
| `mapview/interaction-highlight-plan.ts` | `mapview/interaction-highlight-plan.util.ts` |
| `mapview/render-view.ts` | `mapview/render-view.model.ts` |
| `mapview/tile-grid-visibility.ts` | `mapview/tile-grid-visibility.util.ts` |
| `omnibar/omnibar-history.ts` | `omnibar/omnibar-history.model.ts` |
| `search/feature-search-runtime-state.ts` | `search/feature-search-runtime-state.model.ts` |
| `search/feature-search-style.ts` | `search/feature-search-style.adapter.ts` |
| `search/feature-search.types.ts` | `search/search.model.ts` |
| `search/search-result-density.ts` | `search/search-result-density.visualization.ts` |
| `search/search-style-rule-editor.ts` | `search/search-style-rule-editor.model.ts` |
| `search/simfil-language.ts` | `search/simfil-language.extension.ts` |
| `utils/coordinate-precision.util.ts` | `coordinates/coordinate-precision.util.ts` |

### Merged modules

| Previous file | Surviving model |
| --- | --- |
| `mapdata/map-runtime.ts` | `search/search.model.ts` |
| `utils/tile-feature-id.util.ts` | `inspection/feature-identity.model.ts` |
