import {describe, expect, it} from "vitest";
import type {FilterChannelDefinition} from
    "../../../app/mapdata/filter-subscription.model";
import type { StyleFilterPlan } from "../../../app/mapdata/styled-mapget-layer.model";
import {
    hasAuthoredInteractionHighlight,
    interactionTargetKey,
    planRemoteInteractionHighlights,
    type InteractionHighlightTarget
} from "../../../app/mapview/interaction-highlight-plan.util";
import {tilePartition} from "../../../app/mapdata/partition.model";
import {coreLib, uint8ArrayToWasm} from "../../../app/integrations/wasm.adapter";

const target = (
    featureId: string,
    tileId = 42
): InteractionHighlightTarget => ({
    featureId,
    mapTileKey: `Map/Layer/${tileId}`,
    partition: tilePartition(tileId)
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
        const [result] = planRemoteInteractionHighlights(
            plan(
                channel("feature"),
                channel("attribute"),
                channel("relation")
            ),
            [target("Road.7")]
        );

        expect(result?.plan.channels.map(item => item.scope))
            .toEqual(["feature", "relation"]);
        expect(result?.plan.channels[0].featureFilter)
            .toBe('id == "Road.7"');
    });

    it("builds exact attribute and validity restrictions", () => {
        const rawPlan = plan(channel("attribute", {
            featureFilter: "isRoad",
            entryFilter: "isWarning"
        }));

        const [result] = planRemoteInteractionHighlights(
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
        const [result] = planRemoteInteractionHighlights(
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
        const [result] = planRemoteInteractionHighlights(
            plan(channel("relation", {
                relation: {recursive: true, mergeTwoway: true}
            })),
            [target("Intersection.1:relation#3", 91)]
        );

        expect(result?.plan.channels[0].entryFilter).toBe(
            '($source.id == "Intersection.1" and $relationIndex == 3)'
        );
        expect(result?.partitions).toEqual([tilePartition(91)]);
        expect(result?.roots).toEqual([{
            partition: tilePartition(91),
            featureId: "Intersection.1"
        }]);
    });

    it("activates authored DrivePath relations when selecting a Lane", () => {
        const relation = channel("relation", {
            featureTypes: ["Lane"],
            relation: {
                namePattern: "DRIVE_PATH",
                recursive: false,
                mergeTwoway: false
            },
            geometryName: "centerline"
        });
        const rawPlan = plan(relation);
        const [result] = planRemoteInteractionHighlights(
            rawPlan,
            [target("Lane.1", 91)]
        );

        expect(result?.plan.channels).toEqual([{
            ...relation,
            featureFilter: 'id == "Lane.1"'
        }]);
        expect(result?.partitions).toEqual([tilePartition(91)]);
        expect(result?.roots).toEqual([{
            partition: tilePartition(91),
            featureId: "Lane.1"
        }]);
        expect(rawPlan.channels[0].featureFilter).toBeUndefined();
        expect(hasAuthoredInteractionHighlight(rawPlan, target("Lane.1")))
            .toBe(false);
    });

    it("retains additive relation geometry for a locally rendered Lane", () => {
        const feature = target("Lane.1", 91);
        const rawPlan = plan(channel("feature"), channel("relation"));
        const [result] = planRemoteInteractionHighlights(rawPlan, [feature], {
            localTargetKeys: new Set([interactionTargetKey(feature)])
        });

        expect(result?.plan.channels.map(item => item.scope))
            .toEqual(["relation"]);
        expect(result?.plan.channels[0].featureFilter).toBe('id == "Lane.1"');
        expect(result?.plan.channels[0].entryFilter).toBeUndefined();
        expect(result?.roots).toEqual([{
            partition: tilePartition(91),
            featureId: "Lane.1"
        }]);
    });

    it("retains the selection channel compiled from the DrivePath YAML style", () => {
        const style = uint8ArrayToWasm(
            buffer => new coreLib.FeatureLayerStyle(buffer),
            new TextEncoder().encode(`
name: DrivePaths
version: 2
rules:
  - type: Lane
    fidelity: high
    mode: [selection]
    scope: relation
    relation-type: DRIVE_PATH
    geometry: [line, point]
    color: red
    width: 2
    opacity: .4
    relation-source-style:
      width: 0
    relation-target-style:
      geometry: line
      geometry-name: centerline
      color: cyan
      width: 4
      arrow: forward
      opacity: .4
`)
        );
        const parser = new coreLib.TileLayerParser();
        try {
            expect(style.isValid(), JSON.stringify(style.validationReport()))
                .toBe(true);
            uint8ArrayToWasm(
                buffer => parser.setDataSourceInfo(buffer),
                new TextEncoder().encode(JSON.stringify([{
                    mapId: "Map",
                    layers: {
                        Lane: {
                            type: "Features",
                            featureTypes: ["Lane", "DrivePath"].map(name => ({
                                name,
                                uniqueIdCompositions: [[{
                                    partId: "id", datatype: "U32"
                                }]]
                            }))
                        }
                    }
                }]))
            );
            const rawPlan: StyleFilterPlan = parser.planStyleFilter(
                style, "Map", "Lane",
                coreLib.HighlightMode.SELECTION_HIGHLIGHT.value, 7
            );
            expect(rawPlan.valid).toBe(true);
            expect(rawPlan.issues).toEqual([]);
            expect(rawPlan.channels).toHaveLength(1);
            expect(rawPlan.channels[0]).toMatchObject({
                scope: "relation",
                featureTypes: ["Lane"],
                relation: {namePattern: "DRIVE_PATH"}
            });

            const feature = target("Lane.1", 91);
            const [result] = planRemoteInteractionHighlights(rawPlan, [feature], {
                localTargetKeys: new Set([interactionTargetKey(feature)])
            });
            expect(result?.plan.channels).toEqual([{
                ...rawPlan.channels[0], featureFilter: 'id == "Lane.1"'
            }]);
            expect(result?.roots).toEqual([{
                partition: tilePartition(91), featureId: "Lane.1"
            }]);
            expect(parser.planStyleFilter(
                style, "Map", "Lane",
                coreLib.HighlightMode.NO_HIGHLIGHT.value, 7
            ).channels).toEqual([]);
        } finally {
            parser.delete();
            style.delete();
        }
    });

    it("does not restrict recursive traversal to the selected root's own edges", () => {
        const [result] = planRemoteInteractionHighlights(
            plan(channel("relation", {
                entryFilter: "isTopology",
                relation: {recursive: true, mergeTwoway: true}
            })),
            [target("Intersection.1", 91)]
        );

        expect(result?.plan.channels[0].entryFilter).toBe("isTopology");
        expect(result?.plan.channels[0].relation?.recursive).toBe(true);
        expect(result?.roots).toEqual([{
            partition: tilePartition(91),
            featureId: "Intersection.1"
        }]);
    });

    it.each([
        ["feature", "Lane.1"],
        ["attribute", "Road.1:attribute#2"],
        ["relation", "Lane.1:relation#3"]
    ] as const)("uses local geometry instead of an exact %s fallback", (scope, id) => {
        const feature = target(id);
        expect(planRemoteInteractionHighlights(
            plan(channel(scope)),
            [feature],
            {localTargetKeys: new Set([interactionTargetKey(feature)])}
        )).toEqual([]);
    });

    it("omits locally rendered rows without broadening a remote relation target", () => {
        const localAttribute = target("Road.8:attribute#2", 92);
        const localRelation = target("Intersection.1:relation#3", 93);
        const remoteRelation = target("Intersection.2:relation#4", 94);
        const [result] = planRemoteInteractionHighlights(
            plan(
                channel("feature"),
                channel("attribute"),
                channel("relation")
            ),
            [
                localAttribute,
                localRelation,
                remoteRelation
            ],
            {localTargetKeys: new Set([
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
        expect(result?.partitions).toEqual([tilePartition(94)]);
        expect(result?.roots).toEqual([{
            partition: tilePartition(94),
            featureId: "Intersection.2"
        }]);
    });

    it("deduplicates roots when a feature and one of its relations are selected", () => {
        const [result, ...extraPlans] = planRemoteInteractionHighlights(
            plan(channel("relation", {entryFilter: "isTopology"})),
            [target("Lane.1", 91), target("Lane.1:relation#3", 91)]
        );

        expect(result?.plan.channels[0].entryFilter).toBe("isTopology");
        expect(extraPlans).toEqual([]);
        expect(result?.partitions).toEqual([tilePartition(91)]);
        expect(result?.roots).toEqual([{
            partition: tilePartition(91),
            featureId: "Lane.1"
        }]);
    });

    it.each([false, true])(
        "keeps mixed feature/row selection exact with recursive=%s",
        recursive => {
            const feature = target("Lane.1", 91);
            const row = target("Lane.2:relation#3", 92);
            const rawPlan = plan(channel("relation", {
                entryFilter: "isTopology",
                relation: {recursive, mergeTwoway: false}
            }));
            const results = planRemoteInteractionHighlights(
                rawPlan,
                [feature, row],
                {localTargetKeys: new Set([interactionTargetKey(feature)])}
            );

            expect(results).toHaveLength(2);
            const [wholeFeature, exactRow] = results;
            expect(wholeFeature.plan.channels[0]).toMatchObject({
                featureFilter: 'id == "Lane.1"',
                entryFilter: "isTopology",
                relation: {recursive}
            });
            expect(wholeFeature.partitions).toEqual([tilePartition(91)]);
            expect(wholeFeature.roots).toEqual([{
                partition: tilePartition(91), featureId: "Lane.1"
            }]);
            expect(exactRow.plan.channels[0]).toMatchObject({
                featureFilter: 'id == "Lane.2"',
                entryFilter: '(isTopology) and ' +
                    '(($source.id == "Lane.2" and $relationIndex == 3))'
            });
            expect(exactRow.partitions).toEqual([tilePartition(92)]);
            expect(exactRow.roots).toEqual([{
                partition: tilePartition(92), featureId: "Lane.2"
            }]);
            expect(rawPlan.channels[0].featureFilter).toBeUndefined();
            expect(rawPlan.channels[0].entryFilter).toBe("isTopology");
        }
    );

    it("does not let a feature admit the remote siblings of a local relation", () => {
        const row = target("Lane.2:relation#3", 92);
        const results = planRemoteInteractionHighlights(
            plan(channel("relation")),
            [target("Lane.1", 91), row],
            {localTargetKeys: new Set([interactionTargetKey(row)])}
        );

        expect(results).toHaveLength(1);
        expect(results[0].plan.channels[0].featureFilter).toBe('id == "Lane.1"');
        expect(results[0].roots).toEqual([{
            partition: tilePartition(91), featureId: "Lane.1"
        }]);
    });

    it("does not synthesize relation geometry from feature/attribute fallbacks", () => {
        const rawPlan = plan(channel("feature"), channel("attribute"));
        const feature = target("Lane.1");

        expect(planRemoteInteractionHighlights(
            rawPlan,
            [feature, target("Lane.2:relation#3")],
            {localTargetKeys: new Set([interactionTargetKey(feature)])}
        )).toEqual([]);
    });
});
