// Test-only Cesium integration for Vitest unit tests.
// This variant imports the Cesium ESM entry point so tests can access the
// full engine API without relying on the global UMD bundle. It is only
// used in the "test" build configuration via fileReplacements in
// angular.json and is never part of the production bundle.
import type * as CesiumType from "cesium";
import * as Cesium from "cesium";
export {Cesium, CesiumType};