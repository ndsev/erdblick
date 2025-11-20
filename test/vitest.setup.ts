// Optional Cesium base URL for tests. The test build uses
// app/integrations/cesium.test.ts (ESM import) instead of the UMD
// bundle, so we only need to provide the base path if any code
// consults CESIUM_BASE_URL at runtime.
import {installCoreLibTestStub} from '../app/integrations/wasm';

(globalThis as any).CESIUM_BASE_URL = '/bundle/cesium';

// Ensure the wasm bridge exposes a predictable stub when running tests
// even if the test runner does not set vitest-specific globals early.
installCoreLibTestStub();
