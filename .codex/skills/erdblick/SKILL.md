---
name: erdblick
description: use when working in the erdblick repository, an angular frontend with a wasm-backed native core, map rendering, integration tests, and repo-specific validation rules. covers repo layout, approved build and test commands, browser automation with playwright-cli, chrome devtools mcp for deeper inspection, and strict avoidance of ci-script or npx-playwright fallback for ordinary browser tasks.
---

# Erdblick

Use this skill for implementation, debugging, review work, and browser validation in this repository.

## Quick orientation

- Frontend application: `../../../app/`
- Native/WASM core: `../../../libs/core/`
- C++ tests: `../../../test/`
- Angular specs: `../../../app/**/*.spec.ts`
- Runtime config and styles: `../../../config/`, `../../../config/styles/`, `../../../styles/`
- Built UI bundles: `../../../static/`, `../../../static-visualization-only/`
- Integration assets: `../../../playwright/`
- CI helpers: `../../../ci/`

## Working defaults

- Prefer minimal, focused changes that match surrounding patterns.
- Keep imports local to `app/` when possible.
- Do not change build scripts, CMake, or CI unless the task requires it.
- Do not assume older Cesium-era guidance is still correct. Inspect current integration files before reshaping rendering or map plumbing.

## Task routing

- UI panels, services, Angular wiring: `../../../app/`
- Map state and visualization flow: `../../../app/mapdata/`, `../../../app/mapview/`, `../../../app/shared/`, `../../../app/integrations/wasm.ts`
- Search and inspection behavior: `../../../app/search/`, `../../../app/inspection/`
- Styles and style editor work: `../../../app/styledata/`, `../../../config/styles/`, `../../../styles/`
- Native parsing, tile logic, WASM bindings: `../../../libs/core/` and `../../../test/`
- Browser integration coverage: `../../../playwright/`

## Build and test commands

- UI dev server: `npm start`
- UI build: `npm run build`
- Visualization-only bundle: `./build-ui.bash . visualization-only`
- Lint: `npm run lint`
- Angular unit tests: `ng test`
- Native build: `cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build`
- C++ tests: `cd build && ctest`

Use `ng test` for the TypeScript test layer.
Do not default to `npm run test:vitest` or `npx vitest run`.

## Browser tooling policy

### Primary browser tool
Use `playwright-cli` as the default browser tool for:
- opening the app
- smoke checks
- reproduction
- snapshots
- screenshots
- interactive page automation
- console and network capture
- tracing and video capture

Common flow:
1. `playwright-cli open [url]`
2. `playwright-cli snapshot`
3. use `click`, `fill`, `type`, `press`, `hover`, `select`, `drag`, or `upload`
4. capture evidence with `screenshot`, `console`, `network`, `tracing-start`, `tracing-stop`, `video-start`, `video-stop`

Use session and tab helpers when helpful:
- `state-save`, `state-load`
- `tab-new`, `tab-list`, `tab-select`
- `close`, `close-all`, `kill-all`

### Strict fallback rule
For ordinary browser tasks, do not fall back to:
- `npx playwright`
- `pnpm exec playwright`
- ad hoc Playwright scripts
- shell scripts under `../../../ci/`

Only use those paths when the user explicitly asks for:
- CI-path validation
- a committed Playwright spec
- an existing repo integration workflow that depends on the built bundle and backend tooling

If `playwright-cli` cannot perform a requested browser task, stop and state the limitation instead of silently switching to another browser path.

### Chrome MCP
The repo-local Codex config at `../../config.toml` enables an optional `chrome-devtools` MCP server for `http://127.0.0.1:9222`.

Use Chrome MCP only when deeper inspection is needed than `playwright-cli` provides:
- accessibility snapshots
- richer console or network inspection
- element-level screenshots
- Lighthouse audits
- performance traces

When both are available:
- drive the scenario with `playwright-cli`
- inspect internals with Chrome MCP

If Chrome remote debugging on port `9222` is unavailable, continue with `playwright-cli` alone.

## Validation expectations

- TS-only changes: run `npm run lint` and the smallest reasonable `ng test` coverage for the affected area.
- C++ or WASM-boundary changes: rebuild native artifacts and run `ctest`.
- Styling-only changes: validate the affected YAML and confirm the UI still loads the changed style bundle when practical.
- Visible UI changes: prefer targeted `playwright-cli` validation; add Chrome MCP diagnostics only when needed.
- If validation cannot be run, state that explicitly.

## Useful repo docs

Read these only when relevant:
- Architecture and workflows: `../../../docs/erdblick-dev-guide.md`
- Setup and build modes: `../../../docs/erdblick-setup.md`
- Style YAML system: `../../../docs/erdblick-stylesystem.md`
- Search behavior: `../../../docs/erdblick-search.md`
- Inspection and sourcedata flows: `../../../docs/erdblick-inspection.md`, `../../../docs/erdblick-sourcedata.md`
- Render/view contract: `../../../docs/deck-render-view-contract.md`

## Common pitfalls

- The Angular bundle expects `erdblick-core.wasm` under `build/libs/core`.
- The repo supports both full and visualization-only builds; avoid breaking one mode while changing the other.
- Existing integration workflows may depend on built UI bundles, `mapget`, and backend state.
- Do not claim browser or integration validation passed unless it actually ran.