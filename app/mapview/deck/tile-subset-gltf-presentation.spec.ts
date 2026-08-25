import "@angular/compiler";
import {beforeEach, describe, expect, it, vi} from "vitest";

import {coreLib} from "../../integrations/wasm";
import {TileSubsetGltfPresentation} from
    "./tile-subset-gltf-presentation";

function fixture() {
    const attachmentRef: any = {
        state: "pending",
        ready: Promise.resolve({
            bytes: new Uint8Array([1, 2, 3]),
            etag: null,
            mimeType: "model/gltf-binary"
        }),
        release: vi.fn(() => {
            attachmentRef.state = "released";
        })
    };
    const owner = {
        ownerId: "owner",
        styleOrder: 7,
        highlightMode: coreLib.HighlightMode.NO_HIGHLIGHT,
        retainAttachment: vi.fn(() => attachmentRef)
    };
    const state = {
        tileId: 545666604,
        mapTileKey: "Features:Island-3D:Display3D:545666604"
    };
    const result = {
        glbAttachmentName: "display3d-545666604.glb",
        gltfNodes: {
            nodeIndices: new Uint32Array([4]),
            featureAddresses: new Uint32Array([9]),
            colors: new Uint8Array([10, 20, 30, 255]),
            depthTests: new Uint8Array([1])
        },
        gltfPickProxies: {
            nodeIndices: new Uint32Array([4]),
            featureAddresses: new Uint32Array([9]),
            startIndices: new Uint32Array([0, 3]),
            positions: new Float32Array(9)
        }
    };
    const asset = {
        cacheKey: `${state.mapTileKey}:${result.glbAttachmentName}`,
        attachmentName: result.glbAttachmentName,
        tilePosition: [0, 0, 0],
        byteLength: 3,
        sceneCount: 1,
        modelNodeCount: 1,
        nodeRootCount: 1,
        processedGltf: {},
        destroy: vi.fn()
    };
    const assetRef: any = {
        source: null,
        ready: Promise.resolve(asset),
        released: false,
        release: vi.fn(() => {
            assetRef.released = true;
        })
    };
    const assetStore = {
        retain: vi.fn((source) => {
            assetRef.source = source;
            return assetRef;
        })
    };
    const presentation = new TileSubsetGltfPresentation(
        owner as any,
        state as any,
        assetStore as any
    );
    return {
        attachmentRef,
        owner,
        state,
        result,
        asset,
        assetRef,
        assetStore,
        presentation
    };
}

describe("TileSubsetGltfPresentation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("does not retain an attachment before a Deck device exists", async () => {
        const {owner, result, presentation} = fixture();

        expect(await presentation.prepare(result as any, null)).toBeNull();
        expect(owner.retainAttachment).not.toHaveBeenCalled();
    });

    it("owns and discards the attachment ref together with its parsed asset", async () => {
        const {
            attachmentRef,
            owner,
            result,
            assetRef,
            presentation
        } = fixture();
        const device = {};

        const prepared = await presentation.prepare(result as any, device as any);

        expect(owner.retainAttachment).toHaveBeenCalledWith(
            expect.objectContaining({tileId: 545666604}),
            "display3d-545666604.glb"
        );
        expect(prepared?.attachmentRef).toBe(attachmentRef);
        presentation.discard(prepared);
        expect(assetRef.release).toHaveBeenCalledOnce();
        expect(attachmentRef.release).toHaveBeenCalledOnce();
    });

    it("releases an in-flight attachment when its presentation is destroyed", async () => {
        const {
            attachmentRef,
            result,
            asset,
            assetRef,
            presentation
        } = fixture();
        let finish!: (value: typeof asset) => void;
        assetRef.ready = new Promise(resolve => {
            finish = resolve;
        });

        const preparing = presentation.prepare(result as any, {} as any);
        presentation.destroy(null);

        expect(attachmentRef.release).toHaveBeenCalledOnce();
        finish(asset);
        expect(await preparing).toBeNull();
        expect(assetRef.release).toHaveBeenCalledOnce();
    });

    it("publishes and tears down base nodes, proxies and the exact ref", async () => {
        const {
            attachmentRef,
            result,
            assetRef,
            presentation
        } = fixture();
        const device = {};
        const prepared = await presentation.prepare(result as any, device as any);
        const registry = {
            upsertShared: vi.fn(),
            removeShared: vi.fn()
        };

        const source = presentation.install(
            registry as any,
            result as any,
            [13, 52, 0],
            null,
            vi.fn(),
            {pickable: true, drillPickEligible: true},
            prepared
        );

        expect(source?.data).toEqual([expect.objectContaining({
            nodeIndex: 4,
            featureAddress: 9,
            depthTest: true,
            flatTint: false
        })]);
        expect(registry.upsertShared).toHaveBeenCalledTimes(2);

        presentation.destroy(registry as any);

        expect(registry.removeShared).toHaveBeenCalledTimes(2);
        expect(assetRef.release).toHaveBeenCalledOnce();
        expect(attachmentRef.release).toHaveBeenCalledOnce();
    });
});
