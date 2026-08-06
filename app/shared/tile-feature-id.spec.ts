import {describe, expect, it} from "vitest";

import {tileFeatureInteractionTargetsEqual} from "./tile-feature-id";

const target = (featureId: string, mapTileKey = "Map/Layer/42") => ({
    featureId,
    mapTileKey
});

describe("tile feature interaction identity", () => {
    it("keeps inspection descendants independently hoverable", () => {
        expect(tileFeatureInteractionTargetsEqual(
            target("Road.7"),
            target("Road.7:attribute#2:validity#1")
        )).toBe(false);
        expect(tileFeatureInteractionTargetsEqual(
            target("Road.7:attribute#2"),
            target("Road.7:attribute#2:validity#1")
        )).toBe(false);
    });

    it("matches only the same target in the same tile", () => {
        expect(tileFeatureInteractionTargetsEqual(
            target("Road.7:attribute#2"),
            target("Road.7:attribute#2")
        )).toBe(true);
        expect(tileFeatureInteractionTargetsEqual(
            target("Road.7:attribute#2"),
            target("Road.7:attribute#3")
        )).toBe(false);
        expect(tileFeatureInteractionTargetsEqual(
            target("Road.7"),
            target("Road.7", "Map/Layer/43")
        )).toBe(false);
    });
});
