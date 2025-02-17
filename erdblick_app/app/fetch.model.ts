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
    static CHUNK_TYPE_SOURCEDATA = 3;
    static CHUNK_TYPE_END_OF_STREAM = 128;
    private url: string;
    private method: string;
    public bodyJson: string | null;
    public done: Promise<boolean>|boolean = false;
    private abortController: AbortController;
    private processChunks: boolean;
    private jsonCallback: any;
    private bufferCallback: any;
    private aborted: boolean;

    /**
     * Constructor to initialize the fetch processor with the required parameters.
     * @param {object} coreLib - The WebAssembly core library.
     * @param {string} url - The URL from where to fetch data.
     */
    constructor(url: string) {
        this.url = url;
        this.method = 'GET';
        this.bodyJson = null;
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
    withMethod(method: string) {
        this.method = method;
        return this;
    }

    /**
     * Method to set the body for the request.
     * @param {object} body - The body of the request.
     * @return {Fetch} The Fetch instance for chaining.
     */
    withBody(bodyJson: string) {
        this.bodyJson = bodyJson;
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
    withJsonCallback(callback: any) {
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
    withBufferCallback(callback: any) {
        this.bufferCallback = callback;
        return this;
    }

    /**
     * Method to start the fetch request and process the response.
     */
    async go() {
        let resolve: (v: boolean)=>void;
        this.done = new Promise<boolean>(resolveFun => resolve = resolveFun);

        let requestOptions: Record<string, any> = {
            method: this.method,
            signal: this.abortController.signal,
            mode: "same-origin"
        };
        let headers: Record<string, any> = {};
        if (this.bodyJson) {
            requestOptions["body"] = this.bodyJson;
            headers["Content-Type"] = "application/json";
        }
        requestOptions["headers"] = headers;

        try {
            let response = await fetch(this.url, requestOptions);
            if (response.ok) {
                if (this.jsonCallback) {
                    console.assert(!this.processChunks)
                    await this.handleJsonResponse(response);
                } else if (this.processChunks) {
                    await this.handleChunkedResponse(response);
                } else {
                    await this.handleBlobResponse(response);
                }
            }
        }
        catch (e) {
            this.handleError(e);
        }

        resolve!(true);
    }

    /**
     * Method to handle and process a Blob response.
     * @param {Response} response - The fetch response.
     */
    private async handleBlobResponse(response: Response) {
        const blob = await response.blob();
        this.processBlob(blob);
    }

    /**
     * Method to handle and process a chunked response.
     * The chunks must be encoded as Version-Type-Length-Value (VTLV) frames,
     * where Version is 6B, Type is 1B, Length is 4B (Little Endian).
     * This is the chunk encoding used by the mapget TileLayerStream.
     * @param {Response} response - The fetch response.
     */
    private async handleChunkedResponse(response: Response) {
        if (response.body) {
            const reader = response.body.getReader();
            let accumulatedData = new Uint8Array(0);
            let readIndex = 0;

            const processAccumulatedData = () => {
                while (readIndex + Fetch.CHUNK_HEADER_SIZE <= accumulatedData.length) {
                    const type = accumulatedData[readIndex + 6];
                    const length = new DataView(accumulatedData.buffer, readIndex + 7, 4).getUint32(0, true);

                    if (type == Fetch.CHUNK_TYPE_END_OF_STREAM) {
                        this.abort();
                    }

                    if (readIndex + Fetch.CHUNK_HEADER_SIZE + length <= accumulatedData.length) {
                        // Create a view for the current chunk frame
                        const chunkFrameView = new Uint8Array(accumulatedData.buffer, readIndex, Fetch.CHUNK_HEADER_SIZE + length);
                        this.runBufferCallback(chunkFrameView, type);
                        readIndex += Fetch.CHUNK_HEADER_SIZE + length;
                    } else {
                        break;
                    }
                }

                // If readIndex is not at the start, adjust the accumulatedData
                if (readIndex > 0) {
                    accumulatedData = accumulatedData.slice(readIndex);
                    readIndex = 0;
                }
            }

            while (true) {
                const {done, value} = await reader.read();
                if (value && value.length) {
                    // Append new data to accumulatedData.
                    const temp = new Uint8Array(accumulatedData.length + value.length);
                    temp.set(accumulatedData);
                    temp.set(value, accumulatedData.length);
                    accumulatedData = temp;

                    // Try to process any complete chunks.
                    processAccumulatedData();
                }
                if (done) {
                    break;
                }
            }
        }
    }

    /**
     * Method to handle and process a JSON response.
     * @param {Response} response - The fetch response.
     */
    private async handleJsonResponse(response: Response) {
        const jsonData = await response.json();
        // Serialize the JSON before it is passed to the callback, so that
        // any manipulations to it will not side-effect a later buffer callback.
        let jsonString = JSON.stringify(jsonData);
        if (this.jsonCallback) {
            this.jsonCallback(jsonData);
        }
        let uint8Array = new TextEncoder().encode(jsonString);
        this.runBufferCallback(uint8Array)
    }

    /**
     * Method to process a Blob and pass it to the WASM callback.
     * @param {Blob} blob - The blob to process.
     */
    processBlob(blob: Blob) {
        let fileReader = new FileReader();
        fileReader.onloadend = () => {
            let arrayBuffer = fileReader.result;
            if (arrayBuffer && typeof arrayBuffer !== "string") {
                let uint8Array = new Uint8Array(arrayBuffer);
                this.runBufferCallback(uint8Array);
            }
        };
        fileReader.onerror = (error) => {
            console.error('Error occurred while reading blob:', error);
        };
        fileReader.readAsArrayBuffer(blob);
    }

    /**
     * If there is a WASM callback, construct the shared buffer and call the callback.
     */
    runBufferCallback(uint8Array: Uint8Array, messageType: number = 0)
    {
        if (!this.bufferCallback || this.aborted) {
            return;
        }
        if (this.bufferCallback) {
            this.bufferCallback(uint8Array, messageType);
        }
    }

    /**
     * Signal that the request should be aborted.
     */
    abort() {
        if (this.aborted) {
            return;
        }
        try {
            // For some reason, abort always throws an exception by design.
            this.abortController.abort("User abort.");
        } catch (e) {
            // Nothing to do.
        }
        this.aborted = true;
    }

    /**
     * Log an error if it does not relate to an intentional abort-call.
     */
    handleError(e: any) {
        if (e === "User abort." || (e && e.name === "AbortError")) {
            return;
        }
        console.error(e);
    }
}
