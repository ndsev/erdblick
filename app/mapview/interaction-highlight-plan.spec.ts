import {describe, expect, it} from "vitest";
import type {FilterChannelDefinition} from
    "../mapdata/filter-subscription.model";
import type {StyleFilterPlan} from
    "../mapdata/styled-mapget-layer.model";
import {
    hasAuthoredInteractionHighlight,
    interactionTargetKey,
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
            plan(
                channel("feature"),
                channel("attribute"),
                channel("relation")
            ),
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

    it("does not activate relation channels for bare feature targets", () => {
        const result = planRemoteInteractionHighlight(
            plan(channel("relation", {
                entryFilter: "isTopology"
            })),
            [target("Intersection.1", 91)]
        );

        expect(result).toBeNull();
    });

    it("omits locally rendered exact targets from every channel scope", () => {
        const localFeature = target("Road.7", 91);
        const localAttribute = target("Road.8:attribute#2", 92);
        const localRelation = target("Intersection.1:relation#3", 93);
        const remoteRelation = target("Intersection.2:relation#4", 94);
        const result = planRemoteInteractionHighlight(
            plan(
                channel("feature"),
                channel("attribute"),
                channel("relation")
            ),
            [
                localFeature,
                localAttribute,
                localRelation,
                remoteRelation
            ],
            {localTargetKeys: new Set([
                interactionTargetKey(localFeature),
                interactionTargetKey(localAttribute),
                interactionTargetKey(localRelation)
            ])}
        );

        expect(result?.plan.channels.map(item => item.scope))
            .toEqual(["relation"]);
        expect(result?.plan.channels[0].featureFilter).toBe(
            'id == "Intersection.2"'
        );
        expect(result?.plan.channels[0].entryFilter).toBe(
            '($source.id == "Intersection.2" and $relationIndex == 4)'
        );
        expect(result?.tileIds).toEqual([94]);
        expect(result?.roots).toEqual([{
            tileId: 94,
            featureId: "Intersection.2"
        }]);
    });
});
