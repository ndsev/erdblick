# Service-owned state review checkpoint

The evergreen explanation and source-to-owner inventory are in
[`docs/erdblick-state-actions.md`](../../docs/erdblick-state-actions.md). This ledger
records verification and review scope separately from product documentation.

## Implemented

- All 70 deployed storage registrations moved to their domain owners. Ordered
  `viewIds` adds one registration; the actual startup fixture checks all 71 keys.
  Count and numeric focus remain compatibility projections, not independent
  authoritative membership.
- Domain operations and consumers now use the owning services. AppStateService
  handles registration, persistence, config ownership, snapshots and coordinated
  publication; AppUrlStateService handles the shared legacy URL dictionary.
- Failed edits roll back touched slots, equal final values preserve references,
  completed observers see coherent commits, and queued edits retain persistence
  origin. Ordinary semantic owner methods batch their own multi-value operations.
- Runtime IDs and generations protect asynchronous work and renderer lifetimes.
  URL/snapshot imports use membership workflows; malformed explicit IDs reject
  before mutation. Corrupt saved membership fields recover without discarding
  unrelated stored preferences. Legacy omitted values preserve their mapping.
- Owner controls/actions bind ordinary methods. The pure catalog has 32 public
  actions and 21 controls; native mutation permissions derive from declarations.
  All 12 omnibar producer families use the same registration mechanism. Shared
  close-inspection candidates carry readable feature labels and lifetime tokens.
- Search history captures logical view targets when saved, not when replayed.
  Reorder retains the saved target; removal rejects it. Async feature/plugin jump
  failures propagate through the common dispatcher.
- Layer/style/inspection catalog cleanup stays with each owner and is coordinated
  only after the catalog is complete. Pure discovery reads do not materialize
  defaults or acquire user ownership.
- Domain models and schemas live beside owners. The coordinate text parser is
  shared without a JumpTarget/ExternalViewer/context-menu DI cycle. Existing unit
  and Playwright fixtures use the actual owner/public-control boundaries.

## Verification before independent final build

All frontend test runs used `NG_BUILD_MAX_WORKERS=2`; no native/WASM rebuild was
needed. Logs below are local ignored artifacts in this directory.

| Gate | Result | Evidence |
| --- | --- | --- |
| Official whole suite, `npm test -- --watch=false` | 125 files, 1,357 tests passed | `full-suite-final.log` |
| Final owner/action/history regression run | 3 files, 94 tests passed | `last-owner-check.log` |
| Strict spec TypeScript compilation | Passed | `tsc-final.log`; subsequent official runner also compiled the final tests |
| ESLint | Exit 0; 0 errors, 8 max-lines warnings | `lint-final.json` |
| Diff whitespace check | Passed | `git diff --check` |
| Catalog generation | Passed; 32 actions, 21 controls | `npm run generate:viewer-actions` (also test pre-hook) |

The whole-suite run preceded the final two feature-search history regressions;
the 94-test run includes both the actual owner and SearchPanel history adapter.
The warnings are reported as present warnings, without claiming an unmeasured
baseline count.

At `af62ef99` (the implementation plus the parent-owned omnibar browser spec),
the parent independently passed all 125 files / 1,359 tests and the default
production build in 31.173 seconds (14.54 MB initial bundle; existing size warning).
Read-only review then found the inherited locate network catch could still resolve
as applied. The focused follow-up propagates network/HTTP failure, handles that
rejection in direct UI callers, and expands only the common registration comments.
Its official gate passed 3 files / 37 tests; lint exits 0 with 0 errors and the same
8 max-lines warnings. Logs are `locate-error-gate.log` and `lint-locate-final.log`;
the final rebuilt browser gate remains independent.

The parent independently verified earlier checkpoints:

- `d7048247`: 180-test state/URL/identity gate, profiling build and native browser
  camera/sync/gesture/reload scenario.
- `cd2bc725`: 360-test gate, persistence-origin probe and profiling build. Its
  browser test exposed pre-WASM jump initialization, which was then corrected.
- `24e4034c`: profiling build and the new real native MCP browser acceptance:
  old links, two tabs, control isolation, sync, retained/removed IDs, create/share/
  reload and rendering, with zero page errors.
- The actual new artifact passed the native mapget loader, tools/list routing,
  derived permissions and invalid-control-value rejection before routing.

## Remaining final gates

The parent will run the default production build, an independent official full
suite and the migrated browser workflows against this checkpoint. The new common
omnibar browser scenario is parent-owned. These final results are not implied by
the earlier profiling builds or owner-unit fixtures.

Code-size and dependency comparisons belong to the shared experiment review.
Formatting, moved code, added tests and generated output must be counted separately.
No code was pushed or merged; node_modules and browser output are worktree-local.
