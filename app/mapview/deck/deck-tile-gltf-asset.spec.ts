import {describe, expect, it, vi} from "vitest";

import {
    DeckTileGltfAssetStore,
    type DeckTileGltfAsset,
    type DeckTileGltfAttachmentSource,
    type DeckTileGltfProcessed
} from "./deck-tile-gltf-asset";

function fixture() {
    const source: DeckTileGltfAttachmentSource = {
        cacheKey: "map/layer/42:mesh.glb",
        attachmentName: "mesh.glb",
        tilePosition: [1, 2, 3],
        readBytes: vi.fn()
    };
    const asset: DeckTileGltfAsset = {
        cacheKey: source.cacheKey,
        attachmentName: source.attachmentName,
        tilePosition: source.tilePosition,
        byteLength: 3,
        sceneCount: 1,
        modelNodeCount: 1,
        nodeRootCount: 1,
        processedGltf: {} as DeckTileGltfProcessed,
        destroy: vi.fn()
    };
    return {source, asset};
}

describe("DeckTileGltfAssetStore", () => {
    it("coalesces parsing and releases the shared CPU asset at the last ref", async () => {
        const {source, asset} = fixture();
        const loader = vi.fn().mockResolvedValue(asset);
        const store = new DeckTileGltfAssetStore(loader);

        const first = store.retain(source);
        const second = store.retain(source);

        expect(first).not.toBe(second);
        expect(first.ready).toBe(second.ready);
        expect(await first.ready).toBe(asset);
        expect(loader).toHaveBeenCalledOnce();

        first.release();
        first.release();
        expect(asset.destroy).not.toHaveBeenCalled();
        second.release();
        expect(asset.destroy).toHaveBeenCalledOnce();
    });

    it("destroys a late parse result after its only ref was released", async () => {
        const {source, asset} = fixture();
        let finish!: (value: DeckTileGltfAsset) => void;
        const loader = vi.fn().mockReturnValue(new Promise(resolve => {
            finish = resolve;
        }));
        const store = new DeckTileGltfAssetStore(loader);

        const ref = store.retain(source);
        ref.release();
        expect(ref.released).toBe(true);

        finish(asset);
        expect(await ref.ready).toBe(asset);
        expect(asset.destroy).toHaveBeenCalledOnce();

        const replacement = store.retain(source);
        expect(loader).toHaveBeenCalledTimes(2);
        replacement.release();
    });

    it("keeps null parse results scoped to their active refs", async () => {
        const {source} = fixture();
        const loader = vi.fn().mockResolvedValue(null);
        const store = new DeckTileGltfAssetStore(loader);

        const first = store.retain(source);
        expect(await first.ready).toBeNull();
        first.release();

        const second = store.retain(source);
        expect(await second.ready).toBeNull();
        expect(loader).toHaveBeenCalledTimes(2);
        second.release();
    });
});
