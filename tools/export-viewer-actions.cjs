// Compile the application's actual SignalStore composition for Node, then inspect
// its action metadata without invoking handlers or starting browser resources.
// Node is needed only for this build step; mapget consumes the generated manifest.
// createRequire supports CommonJS dependencies inside the ESM bundle.
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
