/** Decode a DOM SVG without requiring animation frames from a foreground tab. */
export const screenshotRasterizer = {
    /** Own image loading/decoding so cancellation also releases browser work. */
    rasterize(uri: string, width: number, height: number, signal: AbortSignal): Promise<HTMLCanvasElement> {
        return new Promise((resolve, reject) => {
            const image = new Image();
            let frame: number | undefined;
            let fallback: ReturnType<typeof setTimeout> | undefined;
            let finished = false;
            /** Release image work and both scheduling paths on success, failure or cancellation. */
            const cleanup = () => {
                finished = true;
                if (frame !== undefined) cancelAnimationFrame(frame);
                if (fallback !== undefined) clearTimeout(fallback);
                image.onload = null;
                image.onerror = null;
                signal.removeEventListener("abort", abort);
                image.removeAttribute("src");
            };
            /** Abort decoding even when load/decode callbacks have stopped making progress. */
            const abort = () => {
                if (finished) return;
                cleanup();
                reject(signal.reason);
            };
            /** Preserve the post-decode delay needed by Firefox, with a background-tab fallback. */
            const draw = () => {
                if (finished) return;
                try {
                    signal.throwIfAborted();
                    const canvas = document.createElement("canvas");
                    canvas.width = width;
                    canvas.height = height;
                    const context = canvas.getContext("2d");
                    if (!context) throw new Error("Screenshot canvas is unavailable");
                    context.drawImage(image, 0, 0, width, height);
                    cleanup();
                    resolve(canvas);
                } catch (error) {
                    cleanup();
                    reject(error);
                }
            };
            /** Decode rejection can occur for detached SVG images; retain the load-event fallback. */
            const decoded = () => {
                if (finished) return;
                frame = requestAnimationFrame(draw);
                fallback = setTimeout(draw, 50);
            };
            image.onload = () => { void image.decode().then(decoded, decoded); };
            image.onerror = () => {
                if (finished) return;
                cleanup();
                reject(new Error("Browser could not decode the screenshot SVG"));
            };
            signal.addEventListener("abort", abort, {once: true});
            if (signal.aborted) abort();
            else image.src = uri;
        });
    }
};
