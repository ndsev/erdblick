import {beforeAll} from 'vitest';
import {initializeLibrary} from '../app/integrations/wasm';

// Ensure the real WASM core library is initialized once before any tests run.
beforeAll(async () => {
    await initializeLibrary();
});
