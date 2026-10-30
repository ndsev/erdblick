import {
    describe,
    expect,
    it,
    vi
} from "vitest";
import {FeaturePanelComponent} from "../../../app/inspection/feature-panel.component";

describe("point cloud selection and export", () => {
    it("rebuilds inspection without exporting geometry and exports all coordinates on demand", () => {
        const coordinates = Array.from({length: 1000}, (_, i) => [8.7, 47.4, i]);
        const native = {
            inspectionModel: vi.fn(() => []),
            geojson: vi.fn(() => JSON.stringify({type: "Feature", geometry: {type: "MultiPoint", coordinates}}))
        };
        const component = Object.create(FeaturePanelComponent.prototype) as any;
        component.treeData = [];
        component.incoming = new Map();
        component.panel = () => ({id: "points", features: [{featureId: "PointCloudObject.1", featureTile: {hasIncomingRelations: () => false}, peek: (cb: any) => cb(native)}]});
        component.getFeatureTreeDataFromModel = () => [];
        component.rebuildInspectionTree();
        expect(native.inspectionModel).toHaveBeenCalledTimes(1);
        expect(native.geojson).not.toHaveBeenCalled();
        const exported = JSON.parse(component.exportGeoJson());
        expect(exported.features[0].geometry.coordinates).toEqual(coordinates);
        expect(native.geojson).toHaveBeenCalledTimes(1);
    });

    it("does not put empty comma-separated entries into exports when a wrapper is unavailable", () => {
        const component = Object.create(FeaturePanelComponent.prototype) as any;
        component.selectedFeatures = [{peek: () => null}, {peek: () => '{"type":"Feature"}'}];
        expect(JSON.parse(component.exportGeoJson()).features).toEqual([{type: "Feature"}]);
    });
});


describe("deferred incoming inspection", () => {
    function harness(tile: any) {
        const component = Object.create(FeaturePanelComponent.prototype) as any;
        component.incoming = new Map();
        component.scheduleInspectionTreeRebuild = vi.fn();
        component.destroyed = false;
        const feature = {featureId: "Surface.1", featureTile: tile};
        return {component, feature};
    }

    it("does not schedule conventional-only selections", () => {
        const tile = {hasIncomingRelations: () => false, loadIncoming: vi.fn()};
        const {component, feature} = harness(tile);
        expect(component.incomingSection(feature)).toBeUndefined();
        expect(tile.loadIncoming).not.toHaveBeenCalled();
    });

    it("keeps malformed eligibility metadata from interrupting ordinary inspection", () => {
        const tile = {hasIncomingRelations: () => { throw new Error('Invalid declaration'); }, loadIncoming: vi.fn()};
        const {component, feature} = harness(tile);
        const section = component.incomingSection(feature);
        expect(section.incomingLoading).toBe(false);
        expect(section.value).toContain('Invalid declaration');
        expect(tile.loadIncoming).not.toHaveBeenCalled();
    });

    it("publishes loading immediately and preserves source rows after completion", async () => {
        let resolve!: (result: any) => void;
        const tile = {hasIncomingRelations: () => true, loadIncoming: vi.fn(() => new Promise(r => resolve = r))};
        const {component, feature} = harness(tile);
        component.selectedFeatures = [feature];
        const loadingTree = component.getFeatureTreeDataFromModel([[component.incomingSection(feature)]]);
        expect(loadingTree[0].data.incomingLoading).toBe(true);
        expect(loadingTree[0].data.retryIncoming).toBeUndefined();
        resolve({model: [{key: "Incoming Relations", children: [{mapTileKey: "source", key: "Lane.7"}]}],
            complete: true, issues: []});
        await Promise.resolve();
        const section = component.incomingSection(feature);
        expect(section.incomingLoading).toBe(false);
        expect(section.children[0].mapTileKey).toBe("source");
        const loadedTree = component.getFeatureTreeDataFromModel([[section]]);
        expect(loadedTree[0].data.incomingLoading).toBe(false);
        expect(loadedTree[0].data.retryIncoming).toEqual(expect.any(Function));
        expect(loadedTree[0].children[0].data.mapTileKey).toBe("source");
        expect(tile.loadIncoming).toHaveBeenCalledTimes(1);
    });

    it("uses the validated fresh target for inspection and export without starting another query", async () => {
        const refreshed = {isNull: () => false, delete: vi.fn(), geojson: () => '{"type":"Feature","id":"Surface.1","properties":{"revision":2}}'};
        const target = {peek: (callback: any) => callback({find: () => refreshed})};
        const tile = {hasIncomingRelations: () => true, loadIncoming: vi.fn().mockResolvedValue({
            model: [], target, complete: true, issues: []
        })};
        const {component, feature} = harness(tile);
        component.selectedFeatures = [feature];
        component.incomingSection(feature);
        await Promise.resolve();
        expect(component.inspectionFeature(feature).featureTile).toBe(target);
        expect(JSON.parse(component.exportGeoJson()).features[0].properties.revision).toBe(2);
        component.incomingSection(feature);
        expect(tile.loadIncoming).toHaveBeenCalledTimes(1);
    });

    it("reports failure locally and suppresses a cancelled stale completion", async () => {
        const tile = {hasIncomingRelations: () => true, loadIncoming: vi.fn().mockRejectedValue(new Error("Unavailable"))};
        const {component, feature} = harness(tile);
        component.incomingSection(feature);
        await Promise.resolve();
        expect(component.incomingSection(feature).value).toBe("Unavailable");
        let finish!: (result: any) => void;
        tile.loadIncoming.mockImplementation(() => new Promise(r => finish = r));
        component.retryIncoming(feature);
        component.ngOnDestroy();
        finish({model: [], complete: true, issues: []});
        await Promise.resolve();
        expect(component.incoming.size).toBe(0);
    });

    it("renews finite dependencies while keeping the existing rows available for expansion restoration", async () => {
        vi.useFakeTimers();
        const result = {model: [{key: 'Incoming Relations', children: [{key: 'Lane.7', nodeId: 'owner'}]}],
            complete: true, issues: [], expiresAtMs: Date.now() + 1000};
        const tile = {hasIncomingRelations: () => true, loadIncoming: vi.fn().mockResolvedValueOnce(result)
            .mockImplementation(() => new Promise(() => {}))};
        const {component, feature} = harness(tile);
        try {
            component.incomingSection(feature);
            await Promise.resolve();
            vi.advanceTimersByTime(1000);
            expect(tile.loadIncoming).toHaveBeenCalledTimes(2);
            const section = component.incomingSection(feature);
            expect(section.incomingLoading).toBe(true);
            expect(section.children[0].nodeId).toBe('owner');
        } finally {
            component.ngOnDestroy();
            vi.useRealTimers();
        }
    });
});
