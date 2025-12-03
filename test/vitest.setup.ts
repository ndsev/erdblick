import {beforeAll} from 'vitest';
import {initializeLibrary} from '../app/integrations/wasm';

// Optional Cesium base URL for tests. The test build uses
// app/integrations/cesium.test.ts (ESM import) instead of the UMD
// bundle, so we only need to provide the base path if any code
// consults CESIUM_BASE_URL at runtime.
(globalThis as any).CESIUM_BASE_URL = '/bundle/cesium';

// Ensure the real WASM core library is initialized once before any tests run.
beforeAll(async () => {
    await initializeLibrary();
});
