---
name: erdblick-integration
description: Compose and update Playwright integration and snapshot tests for the erdblick repository. Use when adding a new spec under `playwright/snap-tests` or `playwright/tests`, wiring `data-testid` attributes into PrimeNG dialogs or flow-critical controls, choosing test map and location parameters from `test/.env`, preferring URL-driven map state over jump flows, and producing final docs screenshots with labeled overlays.
---

# Erdblick Integration

Use this skill for committed Playwright integration work in this repository.

## Quick orientation

- Snapshot specs: `../../../playwright/snap-tests/`
- Behavioural specs: `../../../playwright/tests/`
- Shared fixture: `../../../playwright/fixtures/test.ts`
- Shared UI helpers: `../../../playwright/utils/ui-helpers.ts`
- Backend helpers: `../../../playwright/utils/backend-helpers.ts`
- Env-backed test parameters: `../../../playwright/utils/test-params.ts`
- Playwright config and harness: `../../../playwright.config.ts`, `../../../playwright/global-setup.ts`, `../../../playwright/global-teardown.ts`
- Test parameter source of truth: `../../../test/.env`
- URL contract: `../../../docs/erdblick-url.md`
- PrimeNG-heavy UI that often needs new test ids: `../../../app/mapdata/`, `../../../app/search/`, `../../../app/mapview/`, `../../../app/inspection/`

## Workflow

### 1. Inspect the target flow before writing the spec

- Read the target component templates and the nearest existing Playwright spec.
- Reuse repo helpers before inventing new ones.
- Use `playwright-cli` first for page driving, hover checks, and quick reproduction.
- Use Chrome MCP only when you need deeper console, network, accessibility, or screenshot diagnostics.

### 2. Read `test/.env` and ask the user which test data to use

Always read `../../../test/.env` and present the current values to the user before finalising the new spec.

At the time this skill was written, the file contains:

- `EB_TEST_MAP_NAME=["TestMap"]`
- `EB_TEST_LAYER_NAME=["WayLayer"]`
- `EB_TEST_VIEW_POSITION=[[42.5,11.615,13]]`

Treat those as examples only. Re-read the file every time and list the current entries.

Always ask the user all of these questions even if there is only one entry per any of these parameters:

1. Which `EB_TEST_VIEW_POSITION` entry should the test use or should a new entry be added and used? 
2. Which `EB_TEST_MAP_NAME` entry should the test use or should a new entry be added and used?
3. Which `EB_TEST_LAYER_NAME` entry should the test use or should a new entry be added and used?

If the needed location, map, or layer is missing:

- stop and ask whether to reuse an existing entry or add a new one to `../../../test/.env`
- do not invent new coordinates, maps, or layers silently
- if a new entry is approved, update `../../../test/.env` and make the spec use the matching index

Interpret the position entries carefully:

- `TEST_VIEW_POSITIONS` is parsed as `[lon, lat, level]`
- the current `navigateToRoot(page, locationIndex)` helper only uses the first two values for the URL and then fixes `alt`, `h`, `p`, and `r`
- do not assume the third tuple entry affects the URL today
- if the scenario truly needs different URL camera parameters, extend the URL-driven helper intentionally and verify against `../../../docs/erdblick-url.md`

### 3. Prefer URL-driven state over jump flows

Default to `navigateToRoot(page, locationIndex)` for the initial map position.

- Prefer URL parameters over `navigateToArea()` everywhere possible.
- Use `navigateToArea()` only when the target state cannot be expressed cleanly through the startup URL or existing URL helpers.
- If you must use a jump action, leave a short comment explaining why URL state was insufficient.

When the test also needs a map and layer enabled, prefer the existing sequence:

```ts
await requireMapSource(request, TEST_MAP_NAMES[mapIndex], TEST_LAYER_NAMES[layerIndex]);
await navigateToRoot(page, locationIndex);
await enableMapLayer(page, TEST_MAP_NAMES[mapIndex], TEST_LAYER_NAMES[layerIndex]);
```

Use `requireTestMapSource()` only when the spec is intentionally fixed to the first default map/layer entry.

### 4. Add or repair `data-testid` attributes before writing locators

Prefer `getByTestId()` over CSS selectors, text locators, or role queries.

If a relevant element does not have a stable `data-testid`, add one in the Angular template first.

Always add `data-testid` when either of these is true:

- a PrimeNG dialog is directly involved in the scenario
- a clickable control is required for the test flow to succeed

Apply this especially to:

- `<p-dialog ... data-testid="...">` for any tested dialog
- buttons, toggles, selects, checkboxes, tree containers, or wrappers that the spec must interact with
- elements that need hover coverage before the visual assertion

Use stable kebab-case names that describe the user-facing function.

Examples already present in the repo:

- `map-layer-dialog`
- `maps-toggle`
- `feature-search-dialog`
- `feature-search-panel`
- `zoom-in-button`
- `move-up-button`

Common gaps to check before adding a new spec:

- dialogs in `../../../app/search/search.panel.component.ts`, `../../../app/inspection/inspection.dialog.component.ts`, `../../../app/inspection/inspection-comparison.dialog.component.ts`, and `../../../app/inspection/sourcedata.selection.dialog.component.ts`
- navigation buttons in `../../../app/mapview/view.ui.component.ts` beyond the currently tagged `zoom-in-button` and `move-up-button`

### 5. Create the snapshot spec under `playwright/snap-tests`

Place new snapshot specs in `../../../playwright/snap-tests/` and let Playwright store baselines under `../../../playwright/reference/snap-tests/` through the existing config.

Use the shared fixture import style:

```ts
import { expect, test } from '../fixtures/test';
```

Use full-screen screenshots only:

```ts
await expect(page).toHaveScreenshot('my-state.png', {
    maxDiffPixelRatio: 0.01
});
```

Do not use:

- `expect(locator).toHaveScreenshot(...)`
- `expect(page.locator('body')).toHaveScreenshot(...)`
- clipped or element-only snapshot assertions for new tests

Keep the scenario deterministic:

- let `navigateToRoot()` wait for readiness, disable animations, and dismiss the survey banner
- open only the UI needed for the state under test
- close transient UI that should not appear in the final full-screen baseline
- prefer existing helpers from `../../../playwright/utils/ui-helpers.ts`

A minimal structure looks like:

```ts
import { expect, test } from '../fixtures/test';
import { requireMapSource } from '../utils/backend-helpers';
import { TEST_LAYER_NAMES, TEST_MAP_NAMES } from '../utils/test-params';
import { enableMapLayer, navigateToRoot } from '../utils/ui-helpers';

test.describe('Snapshot – feature name', () => {
    test('descriptive state name', async ({ page, request }) => {
        const mapIndex = 0;
        const layerIndex = 0;
        const locationIndex = 0;

        await requireMapSource(request, TEST_MAP_NAMES[mapIndex], TEST_LAYER_NAMES[layerIndex]);
        await navigateToRoot(page, locationIndex);
        await enableMapLayer(page, TEST_MAP_NAMES[mapIndex], TEST_LAYER_NAMES[layerIndex]);

        await expect(page).toHaveScreenshot('feature-name.png', {
            maxDiffPixelRatio: 0.01
        });
    });
});
```

### 6. Add explicit hover steps when hover changes the tested state

If a containing element has a hover effect that matters to the component being documented or asserted, add an explicit hover step.

- Hover the relevant element before the screenshot.
- Ignore tooltip assertions.
- Use the hover step only to put the component into the intended visual state.

### 7. Add the final docs screenshot step for relevant interactive controls

If the tested component has directly relevant clickable controls such as buttons, dropdowns, or toggles, add a final non-asserting step that writes a docs screenshot:

```ts
await page.screenshot({
    path: `docs/screenshots/${testName}.png`
});
```

Build this step as follows:

1. Find the relevant controls with locators, preferring `getByTestId()`.
2. Derive a short label for each control.
   Use tooltip text when it is already obvious from the code.
   Otherwise use a short assumption based on the component implementation.
3. Inject overlay labels into the page with `page.evaluate(...)` based on each element's bounding box.
4. Position each label strictly above its target box with a helper that uses fixed tolerances.
5. Take the page screenshot.
6. Do not spend time removing the overlays afterwards; this is the final step.

Prefer a reusable helper in `../../../playwright/utils/ui-helpers.ts` when the overlay logic is more than a few lines.

Use fixed positioning rules instead of ad hoc placement. A good default is:

- vertical gap above the box: `8px`
- viewport padding: `8px`
- clamp the label horizontally inside the viewport
- if a label would leave the viewport, move it upward first, then clamp left/right

Keep overlays non-interactive:

- `position: fixed`
- `pointer-events: none`
- high `z-index`

### 8. Iterate with the existing Playwright harness, not ad hoc servers

If you need to execute the committed spec while iterating:

- do not start a background integration server manually
- rely on `../../../playwright/global-setup.ts`, which already starts `mapget serve` on localhost for the test run
- keep the run local to the normal Playwright harness instead of CI shell scripts

Use these commands when execution is necessary:

- inspect or reproduce manually: `playwright-cli ...`
- run one spec: `npm run test:integration -- playwright/snap-tests/<file>.snap.spec.ts`
- create or refresh only that spec's baseline: `npm run test:integration:update-snapshots -- playwright/snap-tests/<file>.snap.spec.ts`

Do not use:

- `npx playwright ...`
- `bash ./ci/...`
- `sh ./ci/...`
- `node ./ci/...`
- `ng` commands for browser driving

If sandboxing, local port binding, or a missing `mapget` binary prevents the harness from starting, stop and ask the user for the correct local execution path.

## Validation

For a typical new snapshot spec:

- run `npm run lint`
- run the smallest relevant Playwright spec
- if you created a new baseline, run the spec again without `--update-snapshots`
- state explicitly if execution could not be completed

Do not claim the new snapshot passed unless the spec actually ran.
