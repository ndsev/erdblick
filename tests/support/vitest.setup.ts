import {beforeAll} from 'vitest';
import {initializeLibrary} from '../../app/integrations/wasm.adapter';

// Ensure the real WASM core library is initialized once before any tests run.
beforeAll(async () => {
    await initializeLibrary();
});
