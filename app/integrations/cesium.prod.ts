// This file allows us to use ESM-style imports in the
// rest of the erdblick code, while relying on the global
// Cesium UMD bundle included in index.html. Importing the
// runtime module would pull in CommonJS dependencies from
// @cesium/* and trigger optimization bailouts.
//
// We therefore only use type information from the "cesium"
// package and resolve the runtime instance from the global
// UMD bundle via globalThis.Cesium. The following import
// provides full typings without causing a runtime import
// or bundling.
import type * as CesiumType from "cesium";

function getCesiumRuntime(): typeof CesiumType {
    const cesium = (globalThis as any).Cesium as typeof CesiumType | undefined;
    if (!cesium) {
        throw new Error(
            "globalThis.Cesium is not available. Ensure the Cesium UMD bundle is loaded before Angular bootstraps."
        );
    }
    return cesium;
}

const Cesium = getCesiumRuntime();
export {Cesium, CesiumType};