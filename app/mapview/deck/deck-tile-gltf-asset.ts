import {parse} from "@loaders.gl/core";
import {
    GLTFLoader,
    postProcessGLTF,
    type GLTFPostprocessed,
    type GLTFWithBuffers
} from "@loaders.gl/gltf";
import type {GroupNode} from "@luma.gl/engine";

/** Processed CPU-side GLTF document retained independently of a rendering device. */
export type DeckTileGltfProcessed = GLTFPostprocessed & {
    nodes?: Array<{_node?: GroupNode}>;
};

/** Attachment-backed input used by the parsed GLTF asset cache. */
export interface DeckTileGltfAttachmentSource {
    readonly cacheKey: string;
    readonly attachmentName: string;
    readonly tilePosition: [number, number, number];
    readBytes(): Promise<Uint8Array | null>;
}

/** Immutable CPU-side GLTF attachment shared by all presentations of one tile version. */
export interface DeckTileGltfAsset {
    readonly cacheKey: string;
    readonly attachmentName: string;
    readonly tilePosition: [number, number, number];
    readonly byteLength: number;
    readonly sceneCount: number;
    readonly modelNodeCount: number;
    readonly nodeRootCount: number;
    readonly processedGltf: DeckTileGltfProcessed;
    destroy(): void;
}

/** Independently releasable demand for one shared CPU-side GLTF asset. */
export interface DeckTileGltfAssetRef {
    readonly source: DeckTileGltfAttachmentSource;
    readonly ready: Promise<DeckTileGltfAsset | null>;
    readonly released: boolean;
    release(): void;
}

type DeckTileGltfAssetLoader = (
    source: DeckTileGltfAttachmentSource
) => Promise<DeckTileGltfAsset | null>;

interface DeckTileGltfAssetCacheEntry {
    readonly cacheKey: string;
    refCount: number;
    asset: DeckTileGltfAsset | null | undefined;
    promise: Promise<DeckTileGltfAsset | null>;
}

/** Parses one attachment without creating device-owned models or textures. */
async function loadDeckTileGltfAsset(
    source: DeckTileGltfAttachmentSource
): Promise<DeckTileGltfAsset | null> {
    const bytes = await source.readBytes();
    if (!bytes) {
        return null;
    }

    const attachmentBuffer = bytes.slice().buffer as ArrayBuffer;
    const parsed = await parse(attachmentBuffer, GLTFLoader) as GLTFWithBuffers;
    const processed = postProcessGLTF(parsed) as DeckTileGltfProcessed;
    return {
        cacheKey: source.cacheKey,
        attachmentName: source.attachmentName,
        tilePosition: source.tilePosition,
        byteLength: bytes.byteLength,
        sceneCount: processed.scenes?.length ?? 0,
        modelNodeCount: (processed.nodes ?? []).reduce(
            (count, node) => count + (node.mesh ? 1 : 0),
            0
        ),
        nodeRootCount: processed.nodes?.length ?? 0,
        processedGltf: processed,
        // loaders.gl currently exposes no aggregate CPU-document destructor.
        // Keep the boundary explicit so decoded-resource disposal can be added
        // here without involving Deck presentation ownership.
        destroy() {}
    };
}

class DeckTileGltfAssetRefImpl implements DeckTileGltfAssetRef {
    private isReleased = false;

    constructor(
        readonly source: DeckTileGltfAttachmentSource,
        readonly ready: Promise<DeckTileGltfAsset | null>,
        private readonly releaseEntry: () => void
    ) {}

    get released(): boolean {
        return this.isReleased;
    }

    release(): void {
        if (this.isReleased) {
            return;
        }
        this.isReleased = true;
        this.releaseEntry();
    }
}

/**
 * Coalesces CPU parsing while giving every presentation an exact lifetime ref.
 *
 * The cache deliberately has no luma `Device` key. Device-owned scenegraph
 * models and textures are created and destroyed by `DeckGltfNodeLayer`.
 */
export class DeckTileGltfAssetStore {
    private readonly entries = new Map<string, DeckTileGltfAssetCacheEntry>();

    constructor(
        private readonly loadAsset: DeckTileGltfAssetLoader =
            loadDeckTileGltfAsset
    ) {}

    retain(source: DeckTileGltfAttachmentSource): DeckTileGltfAssetRef {
        let entry = this.entries.get(source.cacheKey);
        if (!entry) {
            entry = {
                cacheKey: source.cacheKey,
                refCount: 0,
                asset: undefined,
                promise: Promise.resolve(null)
            };
            const retainedEntry = entry;
            entry.promise = this.loadAsset(source).then(asset => {
                retainedEntry.asset = asset;
                if (retainedEntry.refCount === 0) {
                    asset?.destroy();
                }
                return asset;
            });
            this.entries.set(source.cacheKey, entry);
        }
        entry.refCount += 1;

        const retainedEntry = entry;
        return new DeckTileGltfAssetRefImpl(
            source,
            entry.promise,
            () => this.release(retainedEntry)
        );
    }

    private release(entry: DeckTileGltfAssetCacheEntry): void {
        entry.refCount -= 1;
        if (entry.refCount > 0) {
            return;
        }
        if (this.entries.get(entry.cacheKey) === entry) {
            this.entries.delete(entry.cacheKey);
        }
        entry.asset?.destroy();
    }
}

/** Shared CPU-side GLTF parser/cache used by tile presentations. */
export const deckTileGltfAssetStore = new DeckTileGltfAssetStore();
