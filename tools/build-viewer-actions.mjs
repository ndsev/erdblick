/**
 * Compile the catalog application with Angular's own compiler, then execute it in
 * Node. jsdom supplies a disposable document for Angular's browser providers; no
 * component is mounted and no user's storage or deployment config is loaded.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { compile } from 'json-schema-to-typescript';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';

const compiled = spawnSync(process.execPath, ['node_modules/@angular/compiler-cli/bundles/src/bin/ngc.js', '-p', 'tsconfig.viewer-actions.json'], {
    stdio: 'inherit', env: process.env
});
if (compiled.status !== 0) process.exit(compiled.status ?? 1);

await build({
    entryPoints: ['.angular/viewer-actions/tools/export-viewer-actions.js'],
    outfile: '.angular/viewer-actions/catalog.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    plugins: [{
        name: 'existing-wasm-bindings',
        setup(builder) {
            // ngc emits TypeScript consumers, while the generated JS factory stays
            // in build/. Importing it is inert; catalog startup never initializes it.
            builder.onResolve({ filter: /build\/libs\/core\/erdblick-core$/ }, () => ({
                path: resolve('build/libs/core/erdblick-core.js')
            }));
        }
    }],
    logLevel: 'warning'
});

const dom = new JSDOM('<!doctype html><html><head><base href="/"></head><body></body></html>', {
    url: 'https://catalog.invalid/'
});
const browserGlobals = ['window', 'document', 'localStorage', 'HTMLElement', 'Element', 'Node', 'MutationObserver'];
const runtimeIO = ['fetch', 'XMLHttpRequest', 'WebSocket', 'Worker'];
const originalGlobals = new Map([...browserGlobals, ...runtimeIO]
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
for (const name of browserGlobals) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
// Catalog construction must never invoke runtime IO, even accidentally.
function rejectRuntimeIO() {
    throw new Error('Catalog registration attempted network or worker startup.');
}
for (const name of runtimeIO) {
    Object.defineProperty(globalThis, name, { configurable: true, value: rejectRuntimeIO });
    Object.defineProperty(dom.window, name, { configurable: true, value: rejectRuntimeIO });
}
try {
    await import('../.angular/viewer-actions/catalog.mjs');
} finally {
    dom.window.close();
    // The schema compiler runs in Node after the disposable browser is gone.
    // Restore native globals so it cannot mistake this process for a browser.
    for (const [name, descriptor] of originalGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
    }
}

const output = "app/action/generated";
const catalog = JSON.parse(readFileSync(`${output}/web-mcp-actions.json`, "utf8"));
// Tests and browser clients obtain types from the same collected schemas.
// No controller exports a second declaration map for TypeScript consumers.
const objectSchema = (properties) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false
});
const contractTypes = await compile(objectSchema({
    actions: objectSchema(Object.fromEntries(catalog.actions.map(action => [
        action.name,
        objectSchema({ input: action.inputSchema, output: action.outputSchema })
    ]))),
    controls: objectSchema(Object.fromEntries(catalog.channels.map(control => [
        control.name,
        objectSchema({ selector: control.selectorSchema, value: control.valueSchema })
    ])))
}), "ViewerContract", {
    bannerComment: "/** Generated from the Angular action registrations. Do not edit. */",
    // Preserve small fixed vectors without expanding large bounded lists into
    // enormous unions. Runtime validation always enforces the complete schema.
    maxItems: 10,
    unknownAny: true
});
writeFileSync(`${output}/viewer-contract.d.ts`, contractTypes);
