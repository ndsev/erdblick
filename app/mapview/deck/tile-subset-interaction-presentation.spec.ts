import {describe, expect, it, vi} from "vitest";

import {TileSubsetInteractionPresentation} from
    "./tile-subset-interaction-presentation";

const NO_EFFECT = {
    tintMix: 1,
    opacity: 1,
    edgeWidth: 2,
    haloRadius: 0,
    haloOpacity: 0,
    stripeSpacing: 0,
    stripeWidth: 0,
    stripeOpacity: 0,
    stripeAngle: 45,
    stripeOffset: 0,
    stripeSoftness: 1
};

function source(addresses: number[] = []) {
    return {
        origin: [11, 48, 0],
        modelMatrix: null,
        paths: addresses.length ? [{
            featureAddressesByPath: new Uint32Array(addresses)
        }] : [],
        arrows: [],
        points: [],
        surfaces: [],
        labels: [],
        gltf: null
    } as any;
}

function presentation(
    presentationKind: "regular" | "search" | "hover" | "selection",
    resolvePick: (address: number) => any[] =
        vi.fn((_address: number) => []),
    resolveScope: (address: number) =>
        "feature" | "attribute" | "relation" | "group" =
        vi.fn((_address: number): "feature" => "feature")
) {
    const gltf = {
        reconcileInteractions: vi.fn(),
        installInteraction: vi.fn()
    };
    return {
        gltf,
        value: new TileSubsetInteractionPresentation(
            {
                visualizationId: "visualization",
                ownerId: "owner",
                presentationKind,
                styleOrder: 7,
                viewIndex: 0
            },
            gltf as any,
            resolvePick,
            resolveScope
        )
    };
}

describe("TileSubsetInteractionPresentation", () => {
    it("does not reapply materials to authored hover or selection subsets", () => {
        const overlay = {
            id: "selection",
            targets: [],
            effect: NO_EFFECT,
            order: 1
        };
        for (const kind of ["hover", "selection"] as const) {
            const {value} = presentation(kind);
            value.setOverlays([overlay]);
            expect((value as any).overlays).toEqual([]);
        }
    });

    it("indexes locally retained targets by their terminal scope", () => {
        const targets: Record<number, any[]> = {
            0: [{mapTileKey: "map/layer/42", featureId: "Feature.1"}],
            1: [{
                mapTileKey: "map/layer/42",
                featureId: "Feature.2:attribute#3:validity#1"
            }],
            2: [{
                mapTileKey: "map/layer/42",
                featureId: "Feature.4:relation#2"
            }],
            3: [{mapTileKey: "map/layer/42", featureId: "Feature.5"}]
        };
        const scopes = ["feature", "attribute", "relation", "group"] as const;
        const {value} = presentation(
            "regular",
            vi.fn((address: number) => targets[address] ?? []),
            vi.fn((address: number) => scopes[address] ?? "feature")
        );
        const registry = {
            remove: vi.fn(),
            upsert: vi.fn()
        };

        value.installSource(source([0, 1, 2, 3]), registry as any, null);
        value.refreshPickTargets();

        expect(value.hasLocalTarget(targets[0][0], "feature")).toBe(true);
        expect(value.hasLocalTarget(targets[1][0], "attribute")).toBe(true);
        expect(value.hasLocalTarget(targets[1][0], "feature")).toBe(false);
        expect(value.hasLocalTarget(targets[2][0], "relation")).toBe(true);
        expect(value.hasLocalTarget(targets[3][0], "group")).toBe(true);
    });

    it("tears down GLTF interaction contributions with its source lifetime", () => {
        const {value, gltf} = presentation("regular");
        const registry = {remove: vi.fn(), upsert: vi.fn()};
        value.installSource(source(), registry as any, null);

        value.destroy();

        expect(gltf.reconcileInteractions)
            .toHaveBeenLastCalledWith(registry, new Set());
    });
});
