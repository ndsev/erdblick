// Collect static declarations by importing the actual owner classes, without creating
// Angular services, loading WASM, or accessing browser storage. Bundling resolves their
// Angular/module imports for Node. createRequire supports CommonJS dependencies inside
// the ESM bundle; it does not bootstrap an application or start a discovery server.
const {buildSync} = require("esbuild");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const output = path.resolve(".angular/viewer-actions/export.mjs");
buildSync({
    entryPoints: ["tools/export-viewer-actions.ts"],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "warning",
    tsconfig: "tsconfig.app.json",
    banner: {js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);'}
});
import(pathToFileURL(output).href).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
