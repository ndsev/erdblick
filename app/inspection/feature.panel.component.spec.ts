import {describe, expect, it, vi} from "vitest";
import {FeaturePanelComponent} from "./feature.panel.component";

describe("point cloud selection and export", () => {
    it("rebuilds inspection without exporting geometry and exports all coordinates on demand", () => {
        const coordinates = Array.from({length: 1000}, (_, i) => [8.7, 47.4, i]);
        const native = {
            inspectionModel: vi.fn(() => []),
            geojson: vi.fn(() => JSON.stringify({type: "Feature", geometry: {type: "MultiPoint", coordinates}}))
        };
        const component = Object.create(FeaturePanelComponent.prototype) as any;
        component.treeData = [];
        component.panel = () => ({id: "points", features: [{featureId: "PointCloudObject.1", peek: (cb: any) => cb(native)}]});
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
