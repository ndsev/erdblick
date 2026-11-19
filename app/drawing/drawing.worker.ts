/// <reference lib="webworker" />
import {initializeLibrary, normalizeWasmException} from "../integrations/wasm.adapter";
import {DrawingRuntime} from "./drawing-runtime.adapter";
import type {DrawingWorkerRequest, DrawingWorkerResponse} from "./drawing.model";

const runtime = new DrawingRuntime();
const initialized = initializeLibrary();
let queue = Promise.resolve();
addEventListener("message", ({data}: MessageEvent<DrawingWorkerRequest>) => {
    // Await startup once and preserve command order even when one candidate fails.
    queue = queue.then(async () => {
        await initialized;
        let response: DrawingWorkerResponse;
        try { response = {id: data.id, result: runtime.execute(data.operation)}; }
        catch (error) { response = {id: data.id, error: normalizeWasmException(error).message}; }
        const buffers = [response.result?.bytes, response.result?.schema, response.result?.dictionary]
            .filter((value): value is Uint8Array<ArrayBuffer> => value !== undefined && value.buffer instanceof ArrayBuffer)
            .map(value => value.buffer);
        postMessage(response, buffers);
    }).catch(error => postMessage({id: data.id, error: normalizeWasmException(error).message}));
});
