/**
 * A class to fetch data from a URL and process the response
 * for usage in JavaScript and WebAssembly.
 */
export class Fetch
{
    /**
     * Constructor to initialize the fetch processor with the required parameters.
     * @param {object} coreLib - The WebAssembly core library.
     * @param {string} url - The URL from where to fetch data.
     */
    constructor(coreLib, url) {
        this.coreLib = coreLib;
        this.url = url;
        this.method = 'GET';
        this.body = null;
        this.abortController = new AbortController();
        this.processChunks = false;
        this.jsonCallback = null;
        this.wasmCallback = null;
        this.aborted = false;
    }

    /**
     * Method to set the HTTP method for the request.
     * @param {string} method - The HTTP method ('GET', 'POST', etc.)
     * @return {Fetch} The Fetch instance for chaining.
     */
    withMethod(method) {
        this.method = method;
        return this;
    }

    /**
     * Method to set the body for the request.
     * @param {object} body - The body of the request.
     * @return {Fetch} The Fetch instance for chaining.
     */
    withBody(body) {
        this.body = body;
        return this;
    }

    /**
     * Method to enable chunk processing for the response.
     * @return {Fetch} The Fetch instance for chaining.
     */
    withChunkProcessing() {
        this.processChunks = true;
        return this;
    }

    /**
     * Method to set the callback for handling the JSON response.
     * @param {Function} callback - The callback function.
     * @return {Fetch} The Fetch instance for chaining.
     */
    withJsonCallback(callback) {
        this.jsonCallback = callback;
        return this;
    }

    /**
     * Method to set the callback for handling the WASM response.
     * @param {Function} callback - The callback function.
     * @return {Fetch} The Fetch instance for chaining.
     */
    withWasmCallback(callback) {
        this.wasmCallback = callback;
        return this;
    }

    /**
     * Method to start the fetch request and process the response.
     */
    go() {
        let requestOptions = {
            method: this.method,
            headers: {
                // TODO: Investigate why fetch actually refuses to pass this header.
                //  Currently, the connection stays open for five seconds.
                'Connection': 'close'
            },
            signal: this.abortController.signal,
            keepalive: false,
            mode: "same-origin"
        };

        if (this.body !== null) {
            requestOptions["body"] = JSON.stringify(this.body)
            requestOptions.headers['Content-Type'] = 'application/json'
        }

        fetch(this.url, requestOptions)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                } else {
                    if (this.jsonCallback) {
                        console.assert(!this.processChunks)
                        this.handleJsonResponse(response);
                    } else if (this.processChunks) {
                        this.handleChunkedResponse(response);
                    } else {
                        this.handleBlobResponse(response);
                    }
                }
            })
            .catch(e => console.log('There has been a problem with your fetch operation: ' + e.message));
    }

    /**
     * Method to handle and process a Blob response.
     * @param {Response} response - The fetch response.
     */
    handleBlobResponse(response) {
        response.blob()
            .then(blob => {
                this.processBlob(blob);
            });
    }

    /**
     * Method to handle and process a chunked response.
     * @param {Response} response - The fetch response.
     */
    handleChunkedResponse(response) {
        const reader = response.body.getReader();
        let pump = () => {
            return reader.read().then(({ done, value }) => {
                if (value) {
                    let uint8Array = new Uint8Array(value.buffer);
                    this.runWasmCallback(uint8Array);
                }
                if (done)
                    return;
                return pump();
            });
        }
        pump();
    }

    /**
     * Method to handle and process a JSON response.
     * @param {Response} response - The fetch response.
     */
    handleJsonResponse(response) {
        response.json()
            .then(jsonData => {
                if (this.jsonCallback) {
                    this.jsonCallback(jsonData);
                }

                let jsonString = JSON.stringify(jsonData);
                let uint8Array = new TextEncoder().encode(jsonString);
                this.runWasmCallback(uint8Array)
            });
    }

    /**
     * Method to process a Blob and pass it to the WASM callback.
     * @param {Blob} blob - The blob to process.
     */
    processBlob(blob) {
        let fileReader = new FileReader();
        fileReader.onloadend = () => {
            let arrayBuffer = fileReader.result;
            let uint8Array = new Uint8Array(arrayBuffer);
            this.runWasmCallback(uint8Array)
        };
        fileReader.onerror = (error) => {
            console.error('Error occurred while reading blob:', error);
        };
        fileReader.readAsArrayBuffer(blob);
    }

    /**
     * If there is a WASM callback, construct the shared buffer and call the callback.
     */
    runWasmCallback(uint8Array)
    {
        if (!this.wasmCallback || this.aborted)
            return;

        let sharedArr = new this.coreLib.SharedUint8Array(uint8Array.length);
        let dataPtr = Number(sharedArr.getPointer());

        // Creating an Uint8Array on top of the buffer is essential!
        let memoryView = new Uint8Array(this.coreLib.HEAPU8.buffer);
        memoryView.set(uint8Array, dataPtr);

        if (this.wasmCallback) {
            this.wasmCallback(sharedArr);
        }

        sharedArr.delete();
    }

    /**
     * Signal that the request should be aborted.
     */
    abort() {
        if (this.aborted)
            return
        try {
            // For some reason, abort always throws an exception by design.
            this.abortController.abort("User abort.");
        }
        catch (e) {
            // Nothing to do.
        }
        this.aborted = true;
    }
}
