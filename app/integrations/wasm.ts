import MainModuleFactory, {MainModule as ErdblickCore, SharedUint8Array} from '../../build/libs/core/erdblick-core';

export interface ErdblickCore_ extends ErdblickCore {
    HEAPU8: Uint8Array
}

// Keep as any to allow safe default stub assignment pre-initialization in tests.
export let coreLib: any;

// Served by Angular as a static asset; see angular.json assets (/bundle/wasm).
const wasmAssetPath = '/bundle/wasm/erdblick-core.wasm';

export async function initializeLibrary(): Promise<void> {
    if (coreLib)
        return;
    const lib = await MainModuleFactory({
        locateFile: (path: string) => path.endsWith('.wasm') ? wasmAssetPath : path,
    });
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
const __isUnitTestEnv = (() => {
    try {
        if (typeof globalThis !== 'undefined') {
            if ((globalThis as any).__VITEST__ || (globalThis as any).vitest) {
                return true;
            }
            const proc = (globalThis as any).process;
            if (proc?.env) {
                if (proc.env['VITEST']) return true;
                if (proc.env['NODE_ENV'] === 'test') return true;
                if (proc.env['NG_TEST']) return true;
            }
        }

        if (typeof import.meta !== 'undefined' && (import.meta as any).vitest) {
            return true;
        }
    } catch (e) {
        console.error(e);
    }
    return false;
})();

function createTestCoreLibStub() {
    const HEAPU8 = new Uint8Array(1024 * 1024);
    class SharedArrayStub {
        private len: number;
        constructor(len = 0) { this.len = len; }
        getSize() { return this.len; }
        getPointer() { return 0; }
        delete() {}
    }

    class TileLayerParserStub {
        getFieldDictOffsets() { return [0]; }
        reset() {}
        setDataSourceInfo(_info: any) {}
    }

    class PrimitiveCollectionStub {
        private destroyed = false;
        id = 'primitive-collection';
        destroy() { this.destroyed = true; }
        isDestroyed() { return this.destroyed; }
    }

    class FeatureLayerVisualizationStub {
        private pc: any;

        constructor(
            public viewIndex: number,
            public mapTileKey: string,
            public style: any,
            public options: any,
            public pointMergeService: any,
            public highlightMode: any,
            public featureIdSubset: any,
        ) {
            this.pc = new PrimitiveCollectionStub();
        }

        addTileFeatureLayer(_layer: any) {}
        run() {}
        externalReferences() { return []; }
        mergedPointFeatures() { return {}; }
        primitiveCollection() { return this.pc; }
        processResolvedExternalReferences(_responses: any) {}
        delete() {}
    }

    const ValueType = {
        NULL: { value: 0 },
        ARRAY: { value: 1 << 0 },
        NUMBER: { value: 1 << 1 },
        STRING: { value: 1 << 2 },
    };

    // Very small subset used by unit tests.
    return {
        HEAPU8,
        SharedUint8Array: SharedArrayStub,
        setExceptionHandler: (_: any) => {},
        TileLayerParser: TileLayerParserStub,
        FeatureLayerVisualization: FeatureLayerVisualizationStub,
        ValueType,
        SourceDataAddressFormat: {
            BIT_RANGE: 0,
            INDEX_RANGE: 1,
        },
        getTileIdFromPosition: (_x: number, _y: number, _l: number) => 100n,
        getTilePosition: (_: bigint) => ({ x: 10, y: 10 }),
        getTileNeighbor: (id: bigint, dx: number, dy: number) => id + BigInt(dx + dy * 2),
        getTileLevel: (_: bigint) => 10,
        getTileBox: (_: bigint) => [0, 0, 1, 1],
        getTileIds: (_viewport: any, level: number, limit: number) => {
            const count = Math.min(limit, 4);
            return Array.from({length: count}, (_, i) => BigInt(level * 10 + i));
        },
        getNumTileIds: (_viewport: any, _level: number) => 4,
        getTileFeatureLayerKey: (mapId: string, layerId: string, tileId: bigint) => {
            return `${mapId}/${layerId}/${tileId.toString()}`;
        },
        getSourceDataLayerKey: (mapId: string, layerId: string, tileId: bigint) => {
            return `${mapId}/${layerId}/${tileId.toString()}`;
        },
        getTilePriorityById: (_viewport: any, tileId: bigint) => Number(tileId % 1000n),
        parseMapTileKey: (key: string) => {
            const parts = key.includes(':') ? key.split(':') : key.split('/');
            const [mapId, layerId, tileId] = [parts[0] ?? '', parts[1] ?? '', parts[2] ?? '0'];
            return [mapId, layerId, BigInt(String(tileId).replace(/[^0-9-]/g, '') || '0')];
        },
        validateSimfilQuery: (_query: string) => true,
        HighlightMode: {
            NO_HIGHLIGHT: { value: 0 },
            SELECTION_HIGHLIGHT: { value: 1 },
            HOVER_HIGHLIGHT: { value: 2 }
        },
        GeomType: { POINT: 0, LINESTRING: 1, POLYGON: 2 },
    };
}

let __testStubInstalled = false;

export function installCoreLibTestStub(overrides: Record<string, any> = {}) {
    const stub = Object.assign(createTestCoreLibStub(), overrides);
    coreLib = stub as any;
    __testStubInstalled = true;
    return coreLib;
}

if (!coreLib && __isUnitTestEnv) {
    installCoreLibTestStub();
}
