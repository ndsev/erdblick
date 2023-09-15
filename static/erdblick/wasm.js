"use strict";

/**
 * Run a WASM function which places data in a SharedUint8Array,
 * and then store this data under an object URL. Will be aborted
 * and return null, if the user function returns false.
 */
export function blobUriFromWasm(coreLib, fun, contentType) {
    let sharedGlbArray = new coreLib.SharedUint8Array();
    if (fun(sharedGlbArray) === false) {
        sharedGlbArray.delete();
        return null;
    }
    let objSize = sharedGlbArray.getSize();
    let bufferPtr = Number(sharedGlbArray.getPointer());
    let data = coreLib.HEAPU8.buffer.slice(bufferPtr, bufferPtr + objSize);
    const blob = new Blob([data], { type: contentType });
    const glbUrl = URL.createObjectURL(blob);
    sharedGlbArray.delete();
    return glbUrl;
}

/**
 * Run a WASM function which places data in a SharedUint8Array,
 * and then retrieve this data as a Uint8Array. Will return null
 * if the user function returns false.
 */
export function uint8ArrayFromWasm(coreLib, fun) {
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
export function uint8ArrayToWasm(coreLib, fun, inputData) {
    let sharedGlbArray = new coreLib.SharedUint8Array(inputData.length);
    let bufferPtr = Number(sharedGlbArray.getPointer());
    coreLib.HEAPU8.set(inputData, bufferPtr);
    let result = fun(sharedGlbArray);
    sharedGlbArray.delete();
    return (result === false) ? null : result;
}
