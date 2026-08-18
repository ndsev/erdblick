import "@angular/compiler";
import {BehaviorSubject} from "rxjs";
import {describe, expect, it, vi} from "vitest";
import {coreLib} from "../integrations/wasm";
import type {
    HoverLabelFieldConfig,
    TileFeatureId
} from "../shared/appstate.service";
import {defaultHoverLabelFieldKey} from "../shared/appstate.service";
import {HoverDetailService} from "./hover-detail.service";
import {MapgetLayer} from "./mapget-layer.model";

/** Builds the minimal state and transport surface used by HoverDetailService. */
function createHarness(
    initialFields: HoverLabelFieldConfig[],
    initialEnabled = true
) {
    const hoverLabelFieldsState = new BehaviorSubject(initialFields);
    const hoverLabelsEnabledState = new BehaviorSubject(initialEnabled);
    const state = {
        hoverLabelFieldsState,
        hoverLabelsEnabledState,
        get hoverLabelFields() {
            return hoverLabelFieldsState.getValue();
        },
        get hoverLabelsEnabled() {
            return hoverLabelsEnabledState.getValue();
        }
    };
    const filterRefs: any[] = [];
    const tileStream = {
        createFilterSubscription: vi.fn((definition, _coverage, callbacks) => {
            const ref = {
                definition,
                callbacks,
                generation: 1,
                suspended: false,
                isPending: vi.fn(() => true),
                setCoverage: vi.fn(),
                replace: vi.fn(),
                release: vi.fn(),
                suspend: vi.fn(),
                resume: vi.fn(),
                refresh: vi.fn()
            };
            filterRefs.push(ref);
            return ref;
        }),
        parseMapTileKeySafe: vi.fn(() => ["Map", "Road", 545379780]),
        retainTileAttachment: vi.fn()
    };
    const mapInfo = {
        tileLayerParser: {readTileSubsetLayer: vi.fn()}
    };
    const service = new HoverDetailService(
        state as never,
        mapInfo as never,
        tileStream as never
    );
    const mapgetLayer = new MapgetLayer(
        "source",
        "pool",
        "Map",
        "Road",
        {} as never
    );
    return {service, state, tileStream, filterRefs, mapInfo, mapgetLayer};
}

describe("HoverDetailService", () => {
    it("derives concise display keys from leaf field names", () => {
        expect(defaultHoverLabelFieldKey("abc.speedLimit")).toBe("speedLimit");
        expect(defaultHoverLabelFieldKey("typeId")).toBe("typeId");
    });

    it("renders the intrinsic feature id without creating a filter subscription", () => {
        const {service, tileStream, mapgetLayer} = createHarness([{
            expression: "id",
            customExpression: false
        }]);
        service.reconcileView(0, [{
            mapgetLayer,
            tileIds: [545379780],
            priorityTileIds: [545379780]
        }]);
        const target: TileFeatureId = {
            mapTileKey: "Features:Map:Road:42:0",
            featureId: "Road.42:attribute#1"
        };

        expect(service.detailsFor(0, [target])).toEqual([{
            featureId: "Road.42",
            showFeatureId: true,
            fields: []
        }]);
        expect(tileStream.createFilterSubscription).not.toHaveBeenCalled();
        service.ngOnDestroy();
    });

    it("projects configured fields through a zero-geometry feature channel", () => {
        const {service, tileStream, filterRefs, mapgetLayer} =
            createHarness([
                {expression: "id", customExpression: false},
                {expression: "typeId", customExpression: false}
            ]);
        service.reconcileView(0, [{
            mapgetLayer,
            tileIds: [545379780],
            priorityTileIds: [545379780]
        }]);

        expect(tileStream.createFilterSubscription).toHaveBeenCalledOnce();
        expect(filterRefs[0].definition.channels).toEqual([expect.objectContaining({
            scope: "feature",
            featureFields: ["typeId"],
            entryFields: [],
            geometryTypes: 0
        })]);
        expect(filterRefs[0].definition.channels[0]).not.toHaveProperty(
            "geometryName"
        );
        service.ngOnDestroy();
        expect(filterRefs[0].release).toHaveBeenCalledOnce();
    });

    it("does not rescan unchanged viewport coverage on unrelated reconciliations", () => {
        const {service, filterRefs, mapgetLayer} = createHarness([
            {expression: "typeId", customExpression: false}
        ]);
        const tileIds = [545379780];
        const priorityTileIds = [545379780];
        const coverage = [{mapgetLayer, tileIds, priorityTileIds}];

        service.reconcileView(0, coverage);
        service.reconcileView(0, coverage);

        expect(filterRefs[0].setCoverage).toHaveBeenCalledOnce();
        service.ngOnDestroy();
    });

    it("disables labels and releases projections without deleting their field configuration", () => {
        const {service, state, tileStream, filterRefs, mapgetLayer} =
            createHarness([
                {expression: "id", customExpression: false},
                {expression: "typeId", customExpression: false}
            ]);
        service.reconcileView(0, [{
            mapgetLayer,
            tileIds: [545379780],
            priorityTileIds: [545379780]
        }]);

        expect(tileStream.createFilterSubscription).toHaveBeenCalledOnce();
        state.hoverLabelsEnabledState.next(false);

        expect(filterRefs[0].release).toHaveBeenCalledOnce();
        expect(service.detailsFor(0, [{
            mapTileKey: "Features:Map:Road:42:0",
            featureId: "Road.42"
        }])).toEqual([]);
        expect(state.hoverLabelFieldsState.getValue()).toHaveLength(2);
        service.ngOnDestroy();
    });

    it("reads projected values from the resident subset instead of loading on hover", () => {
        const {service, tileStream, filterRefs, mapInfo, mapgetLayer} =
            createHarness([
                {expression: "id", customExpression: false},
                {expression: "typeId", customExpression: false}
            ]);
        const tileId = 545379780;
        const mapTileKey = coreLib.getTileFeatureLayerKey("Map", "Road", tileId);
        service.reconcileView(0, [{
            mapgetLayer,
            tileIds: [tileId],
            priorityTileIds: [tileId]
        }]);
        mapInfo.tileLayerParser.readTileSubsetLayer.mockReturnValue({
            channelSchema: vi.fn(() => ({
                featureFields: ["typeId"],
                entryCount: 1
            })),
            entryRange: vi.fn(() => [{
                mapTileKey,
                featureId: "Road.42",
                resultIndex: 0,
                values: ["Road"]
            }]),
            delete: vi.fn()
        });
        filterRefs[0].callbacks.onTile({
            blob: new Uint8Array([1]),
            filterId: "hover-details",
            generation: 1,
            mapId: "Map",
            layerId: "Road",
            tileId,
            mapTileKey,
            stringPoolId: "pool",
            dependencies: [{
                sourceTileKey: mapTileKey,
                mapId: "Map",
                layerId: "Road",
                tileId,
                sourceFeatureCount: 1
            }],
            issues: [],
            info: {},
            numEntries: 1,
            geometryVertexCount: 0,
            glbAttachmentName: "",
            receivedAt: 1
        });

        expect(service.detailsFor(0, [{
            mapTileKey,
            featureId: "Road.42"
        }])).toEqual([{
            featureId: "Road.42",
            showFeatureId: true,
            fields: [
                {key: "typeId", value: "Road", colorKey: "typeId"}
            ]
        }]);
        expect(tileStream.parseMapTileKeySafe).toHaveBeenCalledOnce();
        service.ngOnDestroy();
    });

    it("uses a configured display key for projected values", () => {
        const {service, filterRefs, mapInfo, mapgetLayer} = createHarness([{
            expression: "properties.rules.speedLimit",
            customExpression: false,
            displayKey: "limit"
        }]);
        const tileId = 545379780;
        const mapTileKey = coreLib.getTileFeatureLayerKey("Map", "Road", tileId);
        service.reconcileView(0, [{mapgetLayer, tileIds: [tileId], priorityTileIds: [tileId]}]);
        mapInfo.tileLayerParser.readTileSubsetLayer.mockReturnValue({
            channelSchema: vi.fn(() => ({
                featureFields: ["properties.rules.speedLimit"],
                entryCount: 1
            })),
            entryRange: vi.fn(() => [{
                mapTileKey,
                featureId: "Road.42",
                resultIndex: 0,
                values: [80]
            }]),
            delete: vi.fn()
        });
        filterRefs[0].callbacks.onTile({
            blob: new Uint8Array([1]),
            filterId: "hover-details",
            generation: 1,
            mapId: "Map",
            layerId: "Road",
            tileId,
            mapTileKey,
            stringPoolId: "pool",
            dependencies: [],
            issues: [],
            info: {},
            numEntries: 1,
            geometryVertexCount: 0,
            glbAttachmentName: "",
            receivedAt: 1
        });

        expect(service.detailsFor(0, [{mapTileKey, featureId: "Road.42"}]))
            .toEqual([{
                featureId: "Road.42",
                showFeatureId: false,
                fields: [{
                    key: "limit",
                    value: "80",
                    colorKey: "properties.rules.speedLimit"
                }]
            }]);
        service.ngOnDestroy();
    });
});
