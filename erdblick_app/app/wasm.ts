import MainModuleFactory, {MainModule as ErdblickCore} from '../../build/libs/core/erdblick-core';

interface ErdblickCore_ extends ErdblickCore {
    HEAPU8: Uint8Array
}

export let coreLib: ErdblickCore_;

export async function initializeLibrary(): Promise<void> {
    const lib = await MainModuleFactory();
    console.log("  ...done.");
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
export function uint8ArrayFromWasm(fun: any) {
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
export function uint8ArrayToWasm(fun: any, inputData: any) {
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
export async function uint8ArrayToWasmAsync(fun: any, inputData: any) {
    let sharedGlbArray = new coreLib.SharedUint8Array(inputData.length);
    let bufferPtr = Number(sharedGlbArray.getPointer());
    coreLib.HEAPU8.set(inputData, bufferPtr);
    let result = await fun(sharedGlbArray);
    sharedGlbArray.delete();
    return (result === false) ? null : result;
}
