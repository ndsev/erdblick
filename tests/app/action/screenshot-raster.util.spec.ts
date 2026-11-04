import {afterEach, describe, expect, it, vi} from "vitest";
import {screenshotRasterizer} from "../../../app/action/screenshot-raster.util";

/** Controllable load/decode boundary; browser integration covers real SVG pixels. */
class CaptureImage {
    src = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decode = vi.fn(() => Promise.resolve());
    removeAttribute = vi.fn(() => { this.src = ""; });
}

describe("screenshot raster lifecycle", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    /** Supply a decoded image while deliberately withholding all animation frames. */
    function fixture() {
        vi.useFakeTimers();
        const image = new CaptureImage();
        vi.stubGlobal("Image", class { constructor() { return image; } });
        const drawImage = vi.fn();
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({drawImage} as never);
        vi.stubGlobal("requestAnimationFrame", vi.fn(() => 7));
        vi.stubGlobal("cancelAnimationFrame", vi.fn());
        return {image, drawImage};
    }

    it("draws a decoded image even when background animation frames never arrive", async () => {
        const {image, drawImage} = fixture();
        const result = screenshotRasterizer.rasterize("data:image/svg+xml,<svg/>", 640, 480, new AbortController().signal);
        image.onload!();
        await vi.advanceTimersByTimeAsync(50);
        const canvas = await result;
        expect([canvas.width, canvas.height]).toEqual([640, 480]);
        expect(drawImage).toHaveBeenCalledExactlyOnceWith(image, 0, 0, 640, 480);
        expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("cancels a stalled decoder and ignores its late completion", async () => {
        const {image, drawImage} = fixture();
        let finish!: () => void;
        image.decode.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
        const controller = new AbortController();
        const result = screenshotRasterizer.rasterize("data:image/svg+xml,<svg/>", 640, 480, controller.signal);
        const failure = expect(result).rejects.toMatchObject({name: "AbortError"});
        image.onload!();
        controller.abort();
        await failure;
        finish();
        await vi.advanceTimersByTimeAsync(100);
        expect(image.onload).toBeNull();
        expect(image.onerror).toBeNull();
        expect(image.removeAttribute).toHaveBeenCalledWith("src");
        expect(drawImage).not.toHaveBeenCalled();
        expect(requestAnimationFrame).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
