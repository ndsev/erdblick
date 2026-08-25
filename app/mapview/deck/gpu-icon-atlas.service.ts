import {Texture, type Device} from "@luma.gl/core";

const ATLAS_SIZE = 2048;
const ATLAS_PADDING = 1;
const MAX_ICON_SIZE = 512;

/** Immutable worker-facing metadata for one append-only atlas resource. */
export interface GpuIconCatalogEntry {
    uri: string;
    resourceId: number;
    atlasPage: number;
    uv: [number, number, number, number];
    pixelSize: [number, number];
}

interface IconResource extends GpuIconCatalogEntry {
    x: number;
    y: number;
    image: ImageBitmap;
}

interface AtlasPageAllocation {
    page: number;
    x: number;
    y: number;
}

interface AtlasShelf {
    x: number;
    y: number;
    rowHeight: number;
}

interface DeviceAtlasPage {
    texture: Texture;
    uploadedResourceIds: Set<number>;
}

/**
 * Process-wide append-only catalog with one texture copy per Deck device.
 *
 * Resource coordinates never move. Workers receive the small immutable
 * catalog only when its version changes; vector packets reference an atlas
 * page and can therefore upload directly without consulting image state.
 */
export class GpuIconAtlasService {
    private readonly resourcesByUri = new Map<string, IconResource>();
    private readonly loadingByUri = new Map<string, Promise<boolean>>();
    private readonly failedUris = new Set<string>();
    private readonly shelves: AtlasShelf[] = [{x: 0, y: 0, rowHeight: 0}];
    private readonly devicePages = new WeakMap<Device, Map<number, DeviceAtlasPage>>();
    private nextResourceId = 1;
    private _catalogVersion = 0;

    /** Load and append one URL exactly once, reporting whether it became usable. */
    ensureResource(uri: string): Promise<boolean> {
        const normalized = uri.trim();
        if (!normalized || this.failedUris.has(normalized)) {
            return Promise.resolve(false);
        }
        if (this.resourcesByUri.has(normalized)) {
            return Promise.resolve(true);
        }
        const current = this.loadingByUri.get(normalized);
        if (current) {
            return current;
        }
        const loading = this.loadResource(normalized)
            .catch(error => {
                this.failedUris.add(normalized);
                console.warn(`Could not load style icon '${normalized}'.`, error);
                return false;
            })
            .finally(() => this.loadingByUri.delete(normalized));
        this.loadingByUri.set(normalized, loading);
        return loading;
    }

    /** Return a stable serializable snapshot for workers missing this version. */
    catalogEntries(): GpuIconCatalogEntry[] {
        return [...this.resourcesByUri.values()].map(resource => ({
            uri: resource.uri,
            resourceId: resource.resourceId,
            atlasPage: resource.atlasPage,
            uv: [...resource.uv],
            pixelSize: [...resource.pixelSize]
        }));
    }

    /** Resolve and lazily synchronize one fixed atlas page for a Deck device. */
    texture(device: Device, atlasPage: number): Texture {
        let pages = this.devicePages.get(device);
        if (!pages) {
            pages = new Map<number, DeviceAtlasPage>();
            this.devicePages.set(device, pages);
        }
        let page = pages.get(atlasPage);
        if (!page) {
            page = {
                texture: device.createTexture({
                    id: `erdblick-icon-atlas-${atlasPage}`,
                    dimension: "2d",
                    format: "rgba8unorm",
                    width: ATLAS_SIZE,
                    height: ATLAS_SIZE,
                    usage: Texture.SAMPLE | Texture.COPY_DST,
                    sampler: {
                        minFilter: "linear",
                        magFilter: "linear",
                        addressModeU: "clamp-to-edge",
                        addressModeV: "clamp-to-edge"
                    }
                }),
                uploadedResourceIds: new Set<number>()
            };
            pages.set(atlasPage, page);
        }
        for (const resource of this.resourcesByUri.values()) {
            if (resource.atlasPage !== atlasPage ||
                page.uploadedResourceIds.has(resource.resourceId)) {
                continue;
            }
            page.texture.copyExternalImage({
                image: resource.image,
                x: resource.x,
                y: resource.y,
                width: resource.pixelSize[0],
                height: resource.pixelSize[1],
                flipY: true,
                premultipliedAlpha: true
            });
            page.uploadedResourceIds.add(resource.resourceId);
        }
        return page.texture;
    }

    /** Destroy all textures associated with a view/device while retaining decoded resources. */
    releaseDevice(device: Device): void {
        const pages = this.devicePages.get(device);
        if (!pages) {
            return;
        }
        for (const page of pages.values()) {
            page.texture.destroy();
        }
        this.devicePages.delete(device);
    }

    get catalogVersion(): number {
        return this._catalogVersion;
    }

    /** Decode an image and publish its immutable slot only after allocation succeeds. */
    private async loadResource(uri: string): Promise<boolean> {
        const response = await fetch(uri);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        const image = await createImageBitmap(await response.blob(), {
            premultiplyAlpha: "premultiply"
        });
        if (image.width <= 0 || image.height <= 0 ||
            image.width > MAX_ICON_SIZE || image.height > MAX_ICON_SIZE) {
            image.close();
            throw new Error(
                `Icon dimensions must be within 1..${MAX_ICON_SIZE} pixels.`
            );
        }
        const allocation = this.allocate(image.width, image.height);
        const resource: IconResource = {
            uri,
            resourceId: this.nextResourceId++,
            atlasPage: allocation.page,
            x: allocation.x,
            y: allocation.y,
            uv: [
                (allocation.x + 0.5) / ATLAS_SIZE,
                (allocation.y + 0.5) / ATLAS_SIZE,
                (allocation.x + image.width - 0.5) / ATLAS_SIZE,
                (allocation.y + image.height - 0.5) / ATLAS_SIZE
            ],
            pixelSize: [image.width, image.height],
            image
        };
        this.resourcesByUri.set(uri, resource);
        this._catalogVersion += 1;
        return true;
    }

    /** Place one image on a shelf, adding a fixed-size page when necessary. */
    private allocate(width: number, height: number): AtlasPageAllocation {
        for (let page = 0; ; ++page) {
            const shelf = this.shelves[page] ?? {x: 0, y: 0, rowHeight: 0};
            this.shelves[page] = shelf;
            if (shelf.x + width > ATLAS_SIZE) {
                shelf.x = 0;
                shelf.y += shelf.rowHeight + ATLAS_PADDING;
                shelf.rowHeight = 0;
            }
            if (shelf.y + height > ATLAS_SIZE) {
                continue;
            }
            const result = {page, x: shelf.x, y: shelf.y};
            shelf.x += width + ATLAS_PADDING;
            shelf.rowHeight = Math.max(shelf.rowHeight, height);
            return result;
        }
    }
}

/** Shared logical catalog; GPU textures remain isolated per Deck device. */
export const gpuIconAtlasService = new GpuIconAtlasService();
