
export function sharedBufferFromUrl(coreLib, url, callback) {
    fetch(url)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            } else {
                return response.blob();
            }
        })
        .then(blob => {
            let reader = new FileReader();
            reader.onloadend = () => {
                let arrayBuffer = reader.result;
                let uint8Array = new Uint8Array(arrayBuffer);
                let sharedArr = new coreLib.SharedUint8Array(uint8Array.length);
                let dataPtr = Number(sharedArr.getPointer());
                // Creating an Uint8Array on top of the buffer is essential!
                const memoryView = new Uint8Array(coreLib.HEAPU8.buffer);
                for (let i = 0; i < uint8Array.length; i++) {
                    memoryView[dataPtr + i] = uint8Array[i];
                }
                callback(sharedArr);
                sharedArr.delete();
            }
            reader.onerror = (error) => {
                console.error('Error occurred while reading blob:', error);
            }
            reader.readAsArrayBuffer(blob);
        })
        .catch(e => console.log('There has been a problem with your fetch operation: ' + e.message));
}

class SharedArray
{
    constructor(coreLib) {
        this.coreLib = coreLib;
        this.textEncoder = new TextEncoder();
    }

    encode(data) {

    }
}