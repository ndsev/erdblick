# Source roles and dependencies

Every handwritten domain TypeScript module has a role suffix. The suffix
describes its main responsibility and dependency boundary; supporting types,
schemas, constants and helpers stay with their owner. A file need not contain
only one class or only one kind of declaration.

| Suffix | Meaning |
| --- | --- |
| `.model.ts` | Domain values, their schemas and invariants, including value operations and mutable runtime data models. |
| `.state.ts` | The domain's injectable `<Domain>State` container of shared observable AppState values. |
| `.service.ts` | Application operations supplied through Angular dependency injection. |
| `.controller.ts` | Behavior behind a particular component, which uses one current controller for that role. |
| `.util.ts` | A reusable operation or mechanism, including classes with caller-managed state and cleanup. |
| `.adapter.ts` | Translation across an external library, native or application-facing API boundary. |
| `.client.ts` | Communication with a remote protocol, including transport and request lifetime. |
| `.component.ts`, `.directive.ts`, `.pipe.ts`, `.module.ts` | Angular participants with the corresponding decorator. |
| `.protocol.ts`, `.contract.ts` | Messages and public value contracts at a runtime or integration boundary. |
| `.converter.ts` | A named transformation between representations. |
| `.presentation.ts` | A non-Angular UI or rendered-content presentation and its local resources. |
| `.visualization.ts` | A runtime projection of domain data into rendering, including renderer effects. |
| `.layer.ts`, `.extension.ts`, `.host.ts` | Implementations of renderer/editor layer, extension or child-resource hosting APIs. |
| `.datasource.ts` | A data provider for diagnostic/table presentation. |
| `.worker.ts` | A worker entry point with its own runtime initialization. |
| `.constants.ts`, `.shaders.ts` | Shared constants or shader source/modules. |

Use hyphens within the filename stem and dots for roles. Existing compound
boundary names such as `search-completion.worker.protocol.ts` remain explicit.
Entry/composition files, the three configured Angular environment files,
generated action contracts and `.d.ts` declarations have named exceptions.

## Values, state and operations

Models, protocols, contracts and constants must not import application services,
state containers, controllers, UI implementations, clients or runtime adapters.
The restriction includes type-only imports, re-exports and `import(...).Type`.
Move a genuinely shared value contract out of the implementation that happens
to use it; do not create compatibility barrels pointing back into that owner.

Models can have methods, validation, normalization and mutable instance data.
An allocator modeling logical ranges is a model. A generic buffer manager may
be a utility, and a scene owning rendered contributions is a visualization.
The presence of a class or a cleanup method does not determine the role.

State containers own slots, their codecs, derived observations and coherent
value updates. They may depend on another state container where an actual
invariant requires it. AppStateService registration is an explicit infrastructure
dependency; domain controller/service dependencies are forbidden. Storage IO,
network work and rendering remain with the corresponding operational owners.

Domain services contribute actions and controls through `AppActionContributor`.
Their inline declarations bind to `AppActionRegistration`, the small model
contract implemented by AppActionRegistry. Contributors need not import the
registry's dispatch or catalog implementation just to register their operations.

## Controller cardinality

A component needs one current controller for a defined role. This does not
require identical lifetimes or component-local construction. MapPanelComponent
consumes one current MapLayerTree supplied and replaced by MapDataService;
`map-tree.controller.ts` describes that relationship. Other consumers can use
the tree, and it can remain available while the panel is absent. The panel's
per-view tree widgets render projections of the same logical tree.

ViewLayerController instead has direct construction and teardown in
ViewComponent. Both arrangements are valid. Document the component role,
current-instance binding, scope and actual cleanup owner. Keep related records
with the controller unless another consumer needs an independent value contract.

## Utilities and placement

A utility can contain instance-owned queues, caches, timers and explicit cleanup.
FrameBudgetLoop remains a utility: callers supply its work and control its
lifetime. Utilities must not discover application dependencies through injection
or import domain services, controllers or state containers. A utility suffix
alone does not promise purity; models must still use operations appropriate to
their own value responsibilities.

Use at least two production consumers as the normal justification for a
standalone utility. The checker counts importing production modules, including
workers and build tooling, while excluding tests and re-export-only barrels.
Single-consumer utilities produce review warnings during this iteration. Review
colocation or a concrete packaging boundary; do not invent another consumer to
satisfy the number. An import count cannot prove that every exported helper is
reused, so cohesion still needs review.

Domain-specific helpers stay beside their domain even when another domain uses
them. Coordinate precision belongs to coordinates; search export belongs to
search. Domain-independent helpers shared across domains belong in `app/utils/`
and must not import any domain module. Hashing, Unicode bounds and the generic
budgeted work loop satisfy that boundary. Feature identity encoding belongs to
the inspection model, where its schema and value operations can stay together.

## Enforcement and validation

`npm run lint` runs ESLint followed by `npm run lint:structure`.
`tools/source-structure.mjs` performs one TypeScript-resolved graph pass and
fails on missing/unknown suffixes, Angular decorator mismatches, forbidden
dependencies, domain imports from shared utilities and cycles among value/helper
modules. It also rejects Angular participants and named injection facilities in
independent value/helper modules. Configuration lives with this small checker;
there is no second filename/dependency rule inventory.

Reuse counts are warnings. Application service cycles, complete callback purity,
dynamic injection indirection, resource cleanup and controller cardinality still
need review or behavioral tests; this check does not claim to prove them.
The checker's isolated graph tests run with `npm run test:lint-rules`.

Mirror application specs under `tests/app/`, including the source role in a
direct counterpart's filename. Update worker URLs, tooling inputs and imports
together with source moves. Pure filename changes do not rename deployed URL,
storage, snapshot, configuration or MCP keys. Explain substantive modules and
non-obvious ownership with purpose comments, rather than repeating the suffix.
