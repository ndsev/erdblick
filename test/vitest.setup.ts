import {beforeAll} from 'vitest';
import {initializeLibrary} from '../app/integrations/wasm';
import '../app/integrations/cesium.test';

// Optional Cesium base URL for tests. The test build uses
// the ESM package and seeds globalThis.Cesium via cesium.test.ts.
(globalThis as any).CESIUM_BASE_URL = '/bundle/cesium';

// Ensure the real WASM core library is initialized once before any tests run.
beforeAll(async () => {
    await initializeLibrary();
});
