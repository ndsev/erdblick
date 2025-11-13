import MainModuleFactory, {MainModule as ErdblickCore, SharedUint8Array} from '../../build/libs/core/erdblick-core';

export interface ErdblickCore_ extends ErdblickCore {
    HEAPU8: Uint8Array
}

// Keep as any to allow safe default stub assignment pre-initialization in tests.
export let coreLib: any;

export async function initializeLibrary(): Promise<void> {
    if (coreLib)
        return;
    const lib = await MainModuleFactory();
    coreLib = lib as ErdblickCore_;
    coreLib.setExceptionHandler((excType: string, message_1: string) => {
        throw new Error(`${excType}: ${message_1}`);
    });
}

/**
 * Run a WASM function which places data in a SharedUint8Array,
 * and then retrieve this data as a Uint8Array. Will return null
 * if the user function returns false.
 */
export function uint8ArrayFromWasm(fun: (data: SharedUint8Array)=>any) {
    let sharedGlbArray = new coreLib.SharedUint8Array();
    if (fun(sharedGlbArray) === false) {
        sharedGlbArray.delete();
        return null;
    }
    let objSize = sharedGlbArray.getSize();
    let bufferPtr = Number(sharedGlbArray.getPointer());
    let data = new Uint8Array(coreLib.HEAPU8.buffer.slice(bufferPtr, bufferPtr + objSize));
    sharedGlbArray.delete();
    return data;
}

/**
 * Copy the contents of a given Uint8Array to a WASM function
 * through a SharedUint8Array. If the operation fails or the WASM function
 * returns false, null is returned.
 */
export function uint8ArrayToWasm(fun: (d: SharedUint8Array)=>any, inputData: Uint8Array) {
    try {
        let sharedGlbArray = new coreLib.SharedUint8Array(inputData.length);
        let bufferPtr = Number(sharedGlbArray.getPointer());
        coreLib.HEAPU8.set(inputData, bufferPtr);
        let result = fun(sharedGlbArray);
        sharedGlbArray.delete();
        return (result === false) ? null : result;
    } catch (e) {
        console.error(`Error while parsing UINT8 encoded data: ${e}`)
        return undefined;
    }
}

/**
 * (Async version)
 * Copy the contents of a given Uint8Array to a WASM function
 * through a SharedUint8Array. If the operation fails or the WASM function
 * returns false, null is returned.
 */
export async function uint8ArrayToWasmAsync(fun: (d: SharedUint8Array)=>any, inputData: Uint8Array) {
    let sharedGlbArray = new coreLib.SharedUint8Array(inputData.length);
    let bufferPtr = Number(sharedGlbArray.getPointer());
    coreLib.HEAPU8.set(inputData, bufferPtr);
    let result = await fun(sharedGlbArray);
    sharedGlbArray.delete();
    return (result === false) ? null : result;
}

/** Memory usage log. */
export function logFreeMemory() {
    let avail = coreLib!.getFreeMemory()/1024/1024;
    let total = coreLib!.getTotalMemory()/1024/1024;
    console.log(`Free memory: ${Math.round(avail*1000)/1000} MiB (${avail/total}%)`)
}

// Provide a minimal safe default stub for tests and environments
// where the WASM library isn't initialized. This avoids import-time
// crashes when unit tests are collected before vi.mock takes effect.
const __isVitest = (() => {
    try {
        // Vitest sets a global marker and also import.meta.vitest
        if (typeof globalThis !== 'undefined' && (globalThis as any).__VITEST__) return true;
        // @ts-ignore
        if (typeof import.meta !== 'undefined' && (import.meta as any).vitest) return true;
    } catch {}
    return false;
})();

if (!coreLib && __isVitest) {
    const HEAPU8 = new Uint8Array(1024 * 1024);
    class SharedArrayStub {
        private len: number;
        constructor(len = 0) { this.len = len; }
        getSize() { return this.len; }
        getPointer() { return 0; }
        delete() {}
    }

    // Very small subset used by unit tests.
    const stub: any = {
        HEAPU8,
        SharedUint8Array: SharedArrayStub,
        setExceptionHandler: (_: any) => {},
        getTileIdFromPosition: (_x: number, _y: number, _l: number) => 100n,
        getTilePosition: (_: bigint) => ({ x: 10, y: 10 }),
        getTileNeighbor: (id: bigint, dx: number, dy: number) => id + BigInt(dx + dy * 2),
        getTileLevel: (_: bigint) => 10,
        getTileBox: (_: bigint) => [0, 0, 1, 1],
        parseMapTileKey: (key: string) => {
            // Accept both 'map:layer:tile' and 'map/layer/tile' formats.
            const parts = key.includes(':') ? key.split(':') : key.split('/');
            const [mapId, layerId, tileId] = [parts[0] ?? '', parts[1] ?? '', parts[2] ?? '0'];
            return [mapId, layerId, BigInt(String(tileId).replace(/[^0-9-]/g, '') || '0')];
        },
        HighlightMode: { NO_HIGHLIGHT: { value: 0 }, SELECTION_HIGHLIGHT: { value: 1 }, HOVER_HIGHLIGHT: { value: 2 } },
        GeomType: { POINT: 0, LINESTRING: 1, POLYGON: 2 },
    };
    coreLib = stub as ErdblickCore_;
}
