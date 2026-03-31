# State Snapshots For Playwright

Put optional Playwright fixture snapshot files in this directory.

- File format: JSON object keyed by AppStateService state names.
- File extension: `.json`.
- Example fixture selection:
  - Environment: `EB_TEST_STATE_SNAPSHOT=my_snapshot`
  - Playwright option: `test.use({ stateSnapshot: 'my_snapshot' })`

If this directory contains no `.json` files, fixture hydration is skipped and tests use default app state.
