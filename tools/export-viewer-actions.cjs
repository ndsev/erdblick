const {buildSync} = require("esbuild");
const path = require("node:path");
const output = path.resolve(".angular/viewer-actions/export.mjs");
buildSync({entryPoints: ["tools/export-viewer-actions.ts"], outfile: output, bundle: true,
    platform: "node", format: "esm", target: "node24", logLevel: "warning",
    tsconfig: "tsconfig.app.json", banner: {js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);'}});
import(require("node:url").pathToFileURL(output).href).catch(error => { console.error(error); process.exitCode = 1; });
