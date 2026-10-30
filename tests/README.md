# Tests

All application and native test sources live here. Keep `app/` for application
code; place a new Angular spec at the same relative path beneath `tests/app/`.
For example, `app/mapview/mapview.service.ts` is tested by
`tests/app/mapview/mapview.service.spec.ts`.

| Directory | Contents |
| --- | --- |
| `app/` | Angular unit and component specs, mirroring the application domains. |
| `support/` | Angular test setup, state-owner fixtures and typed action-registration helpers. |
| `core/` | Native C++ tests, registered with CTest by `core/CMakeLists.txt`. |
| `playwright/tests/` | Browser integration tests. |
| `playwright/snap-tests/` | Browser screenshot tests. |
| `playwright/fixtures/` | Playwright fixtures, browser examples and mapget datasource configs/scripts. |
| `playwright/utils/` | Shared browser, backend, MCP and saved-state helpers. |
| `playwright/states/` | Saved application state used by browser tests. |
| `playwright/reference/` | Checked-in screenshot baselines. |
| `fixtures/viewer-actions/` | Action-contract validation examples shared with mapget's native tests. |

Run commands from the erdblick root. Framework configuration stays there so the
existing npm scripts, Angular build targets and CI entry points remain usable.
Generated reports still go to `coverage/`, `test-results/` and
`playwright-report/`; they do not belong beside the test sources.

## Angular

```bash
npm run test -- --watch=false
npm run lint
```

The Angular test builder discovers `../tests/app/**/*.spec.ts` relative to the
project's `sourceRoot`, which remains `app/`. A focused run therefore uses the
same relative prefix, even though the command runs from the repository root:

```bash
npm run test -- --watch=false --include '../tests/app/mapview/**/*.spec.ts'
```

Use `npm run test` for Angular specs: it builds their templates and generates
the action catalog before executing Vitest. `tsconfig.spec.json` selects the
specs and `support/` helpers; `tsconfig.eslint.json` also keeps those files in the
typed lint checks. Playwright specs have their own runner and are not part of
this discovery glob.

## Native core

```bash
cmake -S . -B build-test -GNinja -DCMAKE_BUILD_TYPE=Debug
cmake --build build-test --parallel 8
ctest --test-dir build-test --output-on-failure --no-tests=error
```

CTest discovers the suite from the build root. The bundled-style validation
test gets its fixture directory from CMake, so moving the test source does not
change where it looks for `config/styles/`.

## Browser integration and MapViewer

```bash
npm run test:integration:list
EB_MAPGET_MCP_LOCAL=1 EB_MAPGET_CONFIG=tests/playwright/fixtures/mapget-native-grid.yaml \
  npm run test:integration -- tests/playwright/tests/state-owner-actions.spec.ts --project=firefox --workers=1
```

See the [development guide](../docs/erdblick-dev-guide.md#build-and-test) for the
matching native/WASM build and backend configuration required by each suite.
Browser defaults now live in `tests/playwright/.env`. The backend's disposable
PID and authentication files live in the ignored `tests/playwright/.cache/`.
`EB_TEST_STATES_DIR` still overrides the saved-state directory.

MapViewer keeps its own suites under its root-level `test/playwright/` and runs
them through `test/runPlaywrightWithMapviewer.bash`. That wrapper uses erdblick's
built frontend and Playwright installation; MapViewer's config and support
modules import this directory's setup, teardown, fixtures and utilities. Changes
to those shared paths must update both repositories. MapViewer supplies its own
`test/.env` and `test/states/`, so those paths are independent of this layout.

Screenshot baselines move with the suite; moving a test must not regenerate its
expected images. The update command is still `npm run test:integration:update-snapshots`
when an intentional rendering change requires new baselines.
