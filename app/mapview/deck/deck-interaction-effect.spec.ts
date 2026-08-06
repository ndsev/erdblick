import {describe, expect, it} from "vitest";
import type {FeatureLayerStyle, HighlightMode} from
    "../../../build/libs/core/erdblick-core";
import {
    interactionColor,
    resolveDeckInteractionEffect
} from "./deck-interaction-effect";

describe("Deck interaction effects", () => {
    it("resolves the constrained WASM material", () => {
        const style = {
            supportsInteractionEffect: () => true,
            interactionEffect: () => ({
                tint: [255, 128, 0, 255],
                tintMix: 0.5,
                opacity: 0.75,
                edgeWidth: 3,
                haloColor: [0, 0, 0, 255],
                haloRadius: 5,
                haloOpacity: 0.4,
                stripeSpacing: 10,
                stripeWidth: 1,
                stripeOpacity: 0.08,
                stripeAngle: 30,
                stripeOffset: 2,
                stripeSoftness: 0.5
            })
        } as unknown as FeatureLayerStyle;
        const effect = resolveDeckInteractionEffect(
            style,
            {} as HighlightMode,
            {});
        expect(effect).toEqual({
            tint: [255, 128, 0, 255],
            tintMix: 0.5,
            opacity: 0.75,
            edgeWidth: 3,
            haloColor: [0, 0, 0, 255],
            haloRadius: 5,
            haloOpacity: 0.4,
            interiorHalo: true,
            stripeColor: undefined,
            stripeSpacing: 10,
            stripeWidth: 1,
            stripeOpacity: 0.08,
            stripeAngle: 30,
            stripeOffset: 2,
            stripeSoftness: 0.5
        });
    });

    it("applies tint and opacity to packed colors", () => {
        expect(interactionColor(
            new Uint8Array([20, 40, 60, 200]),
            0,
            {
                tint: [220, 140, 40, 255],
                tintMix: 0.25,
                opacity: 0.5,
                edgeWidth: 0,
                haloRadius: 0,
                haloOpacity: 0,
                stripeSpacing: 0,
                stripeWidth: 0,
                stripeOpacity: 0,
                stripeAngle: 45,
                stripeOffset: 0,
                stripeSoftness: 1
            }
        )).toEqual([70, 65, 55, 100]);
    });
});
