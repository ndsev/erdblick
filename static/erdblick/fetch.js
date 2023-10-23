"use strict";

/**
 * A class to fetch data from a URL and process the response
 * for usage in JavaScript and WebAssembly.
 */
export class Fetch
{
    // The chunk header is 6B Version, 1B Type, 4B length
    static CHUNK_HEADER_SIZE = 11;
    static CHUNK_TYPE_FIELDS = 1;
    static CHUNK_TYPE_FEATURES = 2;

    /**
     * Constructor to initialize the fetch processor with the required parameters.
     * @param {object} coreLib - The WebAssembly core library.
     * @param {string} url - The URL from where to fetch data.
     */
    constructor(url) {
        this.url = url;
        this.method = 'GET';
        this.body = null;
        this.abortController = new AbortController();
        this.processChunks = false;
        this.jsonCallback = null;
        this.bufferCallback = null;
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
     * @param {Function} callback - The callback function. Takes
     *  a Uint8Array buffer, and an optional message type parameter
     *  if chunk processing is enabled for this Fetch operation.
     * @return {Fetch} The Fetch instance for chaining.
     */
    withBufferCallback(callback) {
        this.bufferCallback = callback;
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
                        this.handleChunkedResponse(response).then(_ => {}).catch(e => this.handleError(e));
                    } else {
                        this.handleBlobResponse(response);
                    }
                }
            })
            .catch(e => this.handleError(e));
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
     * The chunks must be encoded as Version-Type-Length-Value (VTLV) frames,
     * where Version is 6B, Type is 1B, Length is 4B (Little Endian).
     * This is the chunk encoding used by the mapget TileLayerStream.
     * @param {Response} response - The fetch response.
     */
    async handleChunkedResponse(response) {
        const reader = response.body.getReader();
        let accumulatedData = new Uint8Array(0);

        const processAccumulatedData = () => {
            while (accumulatedData.length >= Fetch.CHUNK_HEADER_SIZE) {
                const type = accumulatedData[6];
                const length = new DataView(accumulatedData.buffer, 7, 4).getUint32(0, true);

                // Check if we have the full chunk.
                if (accumulatedData.length >= Fetch.CHUNK_HEADER_SIZE + length) {
                    const chunkFrame = accumulatedData.slice(0, Fetch.CHUNK_HEADER_SIZE + length);
                    this.runBufferCallback(chunkFrame, type);

                    // Remove the processed data from the beginning of accumulatedData.
                    accumulatedData = accumulatedData.slice(Fetch.CHUNK_HEADER_SIZE + length);
                } else {
                    break;
                }
            }
        }

        while (true) {
            const { done, value } = await reader.read();
            if (value && value.length) {
                // Append new data to accumulatedData.
                const temp = new Uint8Array(accumulatedData.length + value.length);
                temp.set(accumulatedData);
                temp.set(value, accumulatedData.length);
                accumulatedData = temp;

                // Try to process any complete chunks.
                processAccumulatedData();
            }
            if (done) break;
        }
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
                this.runBufferCallback(uint8Array)
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
            this.runBufferCallback(uint8Array)
        };
        fileReader.onerror = (error) => {
            console.error('Error occurred while reading blob:', error);
        };
        fileReader.readAsArrayBuffer(blob);
    }

    /**
     * If there is a WASM callback, construct the shared buffer and call the callback.
     */
    runBufferCallback(uint8Array, messageType)
    {
        if (!this.bufferCallback || this.aborted)
            return;
        if (this.bufferCallback) {
            this.bufferCallback(uint8Array, messageType);
        }
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

    /**
     * Log an error if it does not relate to an intentional abort-call.
     */
    handleError(e) {
        if (e !== "User abort.") {
            console.error(e);
        }
    }
}
