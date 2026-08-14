import type {Device, Texture} from "@luma.gl/core";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {GpuIconAtlasService} from "./gpu-icon-atlas.service";

/** Minimal atlas texture which records image uploads and retirement. */
class FakeAtlasTexture {
    readonly uploads: unknown[] = [];
    destroyed = false;

    /** Retain one external-image upload for assertions. */
    copyExternalImage(options: unknown): void {
        this.uploads.push(options);
    }

    /** Mark this device-local atlas allocation retired. */
    destroy(): void {
        this.destroyed = true;
    }
}

/** Device stub that exposes atlas texture creation without a graphics context. */
class FakeAtlasDevice {
    readonly textures: FakeAtlasTexture[] = [];

    /** Allocate one observable page texture. */
    createTexture(): Texture {
        const texture = new FakeAtlasTexture();
        this.textures.push(texture);
        return texture as unknown as Texture;
    }
}

describe("GpuIconAtlasService", () => {
    const images: Array<{width: number; height: number; close: ReturnType<typeof vi.fn>}> = [];

    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn(async () => ({
            ok: true,
            blob: async () => new Blob()
        })));
        vi.stubGlobal("createImageBitmap", vi.fn(async () => {
            const image = {width: 16, height: 8, close: vi.fn()};
            images.push(image);
            return image;
        }));
    });

    afterEach(() => {
        images.length = 0;
        vi.unstubAllGlobals();
    });

    it("deduplicates concurrent loads and never moves published UVs", async () => {
        const service = new GpuIconAtlasService();
        await Promise.all([
            service.ensureResource("icon-a.png"),
            service.ensureResource(" icon-a.png ")
        ]);
        const first = service.catalogEntries()[0];
        await service.ensureResource("icon-b.png");

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(service.catalogVersion).toBe(2);
        expect(service.catalogEntries()[0]).toEqual(first);
        expect(service.catalogEntries().map(entry => entry.resourceId))
            .toEqual([1, 2]);
        expect(service.catalogEntries()[1].uv[0]).toBeGreaterThan(first.uv[0]);
        expect(first.uv).toEqual([
            0.5 / 2048,
            0.5 / 2048,
            15.5 / 2048,
            7.5 / 2048
        ]);
    });

    it("uploads each resource once per device and recreates released pages", async () => {
        const service = new GpuIconAtlasService();
        await service.ensureResource("icon.png");
        const device = new FakeAtlasDevice();

        const first = service.texture(device as unknown as Device, 0);
        expect(service.texture(device as unknown as Device, 0)).toBe(first);
        expect(device.textures).toHaveLength(1);
        expect(device.textures[0].uploads).toHaveLength(1);

        service.releaseDevice(device as unknown as Device);
        expect(device.textures[0].destroyed).toBe(true);
        service.texture(device as unknown as Device, 0);
        expect(device.textures).toHaveLength(2);
        expect(device.textures[1].uploads).toHaveLength(1);
    });
});
