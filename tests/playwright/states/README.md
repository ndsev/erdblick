# State JSONs For Playwright

Put optional Playwright fixture state JSON files in this directory.

- File format: JSON object keyed by AppStateService state names.
- Style options are top-level compact storage entries such as `"STY0~0~showLanes": "1"`, not a nested `styleOptions` object.
- File extension: `.json`.
- Example fixture selection:
  - Environment: `EB_TEST_STATE_SNAPSHOT=my_snapshot`
  - Playwright option: `test.use({ stateSnapshot: 'my_snapshot' })`

If this directory contains no `.json` files, fixture hydration is skipped and tests use default app state.
