/**
 * Compile the catalog application with Angular's own compiler, then execute it in
 * Node. jsdom supplies a disposable document for Angular's browser providers; no
 * component is mounted and no user's storage or deployment config is loaded.
 */
import { spawnSync } from 'node:child_process';
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
for (const name of ['window', 'document', 'localStorage', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
// Catalog construction must never invoke runtime IO, even accidentally.
function rejectRuntimeIO() {
    throw new Error('Catalog registration attempted network or worker startup.');
}
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'Worker']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: rejectRuntimeIO });
    Object.defineProperty(dom.window, name, { configurable: true, value: rejectRuntimeIO });
}
try {
    await import('../.angular/viewer-actions/catalog.mjs');
} finally {
    dom.window.close();
}
