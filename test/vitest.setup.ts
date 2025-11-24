import {beforeAll} from 'vitest';
import {initializeLibrary} from '../app/integrations/wasm';

// Optional Cesium base URL for tests. The test build uses
// app/integrations/cesium.test.ts (ESM import) instead of the UMD
// bundle, so we only need to provide the base path if any code
// consults CESIUM_BASE_URL at runtime.
(globalThis as any).CESIUM_BASE_URL = '/bundle/cesium';

// Minimal ImageBitmap / createImageBitmap polyfills for the jsdom test
// environment so Cesium's texture and image handling paths used by the
// WASM renderer can execute without throwing ReferenceError.
if (typeof (globalThis as any).ImageBitmap === 'undefined') {
    (globalThis as any).ImageBitmap = class ImageBitmapStub {
        close() {
            // no-op
        }
    };
}
if (typeof (globalThis as any).createImageBitmap === 'undefined') {
    (globalThis as any).createImageBitmap = async (image: any) => image as any;
}

// Ensure the real WASM core library is initialized once before any tests run.
beforeAll(async () => {
    await initializeLibrary();
});
