import {describe, expect, it} from "vitest";
import type {FilterChannelDefinition} from
    "../mapdata/filter-subscription.model";
import type {StyleFilterPlan} from
    "../mapdata/styled-mapget-layer.model";
import {
    hasAuthoredInteractionHighlight,
    planRemoteInteractionHighlight,
    type InteractionHighlightTarget
} from "./interaction-highlight-plan";

const target = (
    featureId: string,
    tileId = 42
): InteractionHighlightTarget => ({
    featureId,
    mapTileKey: `Map/Layer/${tileId}`,
    tileId
});

const channel = (
    scope: FilterChannelDefinition["scope"],
    overrides: Partial<FilterChannelDefinition> = {}
): FilterChannelDefinition => ({
    channelId: scope,
    scope,
    rewrite: false,
    featureTypes: [],
    featureFields: [],
    entryFields: [],
    geometryTypes: 0,
    geometryName: "*",
    ...overrides
});

const plan = (...channels: FilterChannelDefinition[]): StyleFilterPlan => ({
    valid: true,
    channels,
    issues: []
});

describe("remote interaction highlight planning", () => {
    it("does not activate attribute channels for a bare feature target", () => {
        const result = planRemoteInteractionHighlight(
            plan(channel("feature"), channel("attribute")),
            [target("Road.7")]
        );

        expect(result?.plan.channels.map(item => item.scope))
            .toEqual(["feature"]);
        expect(result?.plan.channels[0].featureFilter)
            .toBe('id == "Road.7"');
    });

    it("builds exact attribute and validity restrictions", () => {
        const rawPlan = plan(channel("attribute", {
            featureFilter: "isRoad",
            entryFilter: "isWarning"
        }));

        const result = planRemoteInteractionHighlight(
            rawPlan,
            [target("Road.7:attribute#2:validity#1")]
        );

        expect(result?.plan.channels[0]).toMatchObject({
            featureFilter: '(isRoad) and (id == "Road.7")',
            entryFilter: '(isWarning) and (($feature.id == "Road.7" and ' +
                '$attributeIndex == 2 and $hasValidity and $validityIndex == 1))'
        });
        expect(rawPlan.channels[0]).toMatchObject({
            featureFilter: "isRoad",
            entryFilter: "isWarning"
        });
    });

    it("does not add a host-feature channel to an attribute highlight", () => {
        const feature = target("Road.7:attribute#2");
        const result = planRemoteInteractionHighlight(
            plan(channel("feature"), channel("attribute")),
            [feature]
        );

        expect(result?.plan.channels.map(item => item.scope))
            .toEqual(["attribute"]);
        expect(hasAuthoredInteractionHighlight(
            plan(channel("attribute")),
            feature
        )).toBe(true);
        expect(hasAuthoredInteractionHighlight(
            plan(channel("feature")),
            feature
        )).toBe(false);
    });

    it("restricts an explicitly selected relation and emits exact roots", () => {
        const result = planRemoteInteractionHighlight(
            plan(channel("relation", {
                relation: {recursive: true, mergeTwoway: true}
            })),
            [target("Intersection.1:relation#3", 91)]
        );

        expect(result?.plan.channels[0].entryFilter).toBe(
            '($source.id == "Intersection.1" and $relationIndex == 3)'
        );
        expect(result?.tileIds).toEqual([91]);
        expect(result?.roots).toEqual([{
            tileId: 91,
            featureId: "Intersection.1"
        }]);
    });

    it("does not over-restrict recursive relations when any bare root remains", () => {
        const result = planRemoteInteractionHighlight(
            plan(channel("relation", {
                entryFilter: "isTopology"
            })),
            [
                target("Intersection.1", 91),
                target("Intersection.2:relation#3", 92)
            ]
        );

        expect(result?.plan.channels[0].entryFilter).toBe("isTopology");
        expect(result?.roots).toEqual([
            {tileId: 91, featureId: "Intersection.1"},
            {tileId: 92, featureId: "Intersection.2"}
        ]);
    });
});
