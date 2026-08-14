import {describe, expect, it} from "vitest";
import {DeckLayerRegistry} from "./deck-layer-registry";
import {
    DeckInteractionOutlineService,
    deckInteractionHaloUsesCoverage,
    deckInteractionOutlineUniforms,
    deckInteractionStripeOrigin,
    isDeckInteractionMaskLayer
} from "./deck-interaction-outline.service";

const effect = {
    tint: [255, 128, 0, 255] as [number, number, number, number],
    tintMix: 0.5,
    opacity: 0.75,
    edgeWidth: 4,
    haloColor: [0, 0, 0, 128] as [number, number, number, number],
    haloRadius: 6,
    haloOpacity: 0.4,
    stripeSpacing: 10,
    stripeWidth: 1,
    stripeOpacity: 0.08,
    stripeAngle: 30,
    stripeOffset: 2,
    stripeSoftness: 0.5
};

describe("DeckInteractionOutlineService", () => {
    it("normalizes the inner and outer screen-space bands", () => {
        expect(deckInteractionOutlineUniforms(effect, [800, 600])).toEqual({
            textureSize: [800, 600],
            tintColor: [1, 128 / 255, 0, 1],
            haloColor: [0, 0, 0, 128 / 255],
            stripeColor: [1, 128 / 255, 0, 1],
            stripeAxis: [
                Math.sin(Math.PI / 6),
                Math.cos(Math.PI / 6)
            ],
            stripeOrigin: [0, 0],
            tintMix: 0.5,
            opacity: 0.75,
            // Edge classification follows the edge field only. Halo radius
            // is intentionally an independent blur scale.
            edgeThreshold: 0.5 + 0.35 * 4 / 8,
            haloOpacity: 0.4,
            stripeSpacing: 10,
            stripeWidth: 1,
            stripeOpacity: 0.08,
            stripeOffset: 2,
            stripeSoftness: 0.5,
            hasTint: 1,
            hasHalo: 1,
            hasInteriorHalo: 1,
            hasStripe: 1
        });
    });

    it("anchors screen-space stripe phase to a projected world point", () => {
        const viewport = {
            x: 100,
            y: 50,
            width: 400,
            height: 300,
            project: vi.fn(() => [20, 70])
        } as never;

        expect(deckInteractionStripeOrigin(
            viewport,
            [11, 48, 0],
            [1600, 1200],
            [800, 600]
        )).toEqual([240, 640]);
        expect((viewport as any).project).toHaveBeenCalledWith(
            [11, 48, 0],
            {topLeft: false}
        );
    });

    it("keeps edge classification invariant when only the halo changes", () => {
        const withoutHalo = deckInteractionOutlineUniforms({
            ...effect,
            haloRadius: 0,
            haloOpacity: 0
        });
        const largeHalo = deckInteractionOutlineUniforms({
            ...effect,
            haloRadius: 12,
            haloOpacity: 1
        });

        expect(largeHalo.edgeThreshold).toBe(withoutHalo.edgeThreshold);
    });

    it("can constrain a style glow to the outside silhouette", () => {
        const styleGlow = {
            ...effect,
            tint: undefined,
            tintMix: 0,
            interiorHalo: false
        };
        expect(deckInteractionOutlineUniforms(styleGlow).hasInteriorHalo)
            .toBe(0);
        expect(deckInteractionHaloUsesCoverage(styleGlow)).toBe(true);
        expect(deckInteractionHaloUsesCoverage(effect)).toBe(false);
    });

    it("allocates stable, distinct non-zero identities within one group", () => {
        const service = new DeckInteractionOutlineService(
            new DeckLayerRegistry(null));
        const first = service.identityColor("hover", "feature-a", effect, 10);
        const repeated = service.identityColor("hover", "feature-a", effect, 10);
        const second = service.identityColor("hover", "feature-b", effect, 10);

        expect(first).toEqual([1, 0, 0, 255]);
        expect(repeated).toEqual(first);
        expect(second).toEqual([2, 0, 0, 255]);
    });

    it("refreshes the stripe anchor of an existing group", () => {
        const service = new DeckInteractionOutlineService(
            new DeckLayerRegistry(null));
        service.identityColor("hover", "feature-a", effect, 10);

        service.configureGroup("hover", effect, 12, [11, 48, 3]);

        expect((service as unknown as {
            groups: Map<string, {
                order: number;
                stripeAnchor: [number, number, number] | null;
            }>;
        }).groups.get("hover")).toMatchObject({
            order: 12,
            stripeAnchor: [11, 48, 3]
        });
    });

    it("recognizes only the hidden mask layer namespace", () => {
        expect(isDeckInteractionMaskLayer(
            "builtin/interaction-mask/group/source")).toBe(true);
        expect(isDeckInteractionMaskLayer(
            "builtin/interaction-outline/group")).toBe(false);
    });
});
