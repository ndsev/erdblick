// Test-only Cesium integration for Vitest unit tests.
// This variant imports the Cesium ESM entry point so tests can access the
// full engine API without relying on the global UMD bundle. It is only
// used in the "test" build configuration via fileReplacements in
// angular.json and is never part of the production bundle.
import type * as CesiumType from "cesium";
import * as Cesium from "cesium";

// Expose Cesium on the global object as well so the WASM core, which
// looks up classes like `Cesium.ArcType` via the global namespace,
// can interoperate correctly in tests.
if (!(globalThis as any).Cesium) {
    (globalThis as any).Cesium = Cesium;
}

export {Cesium, CesiumType};
