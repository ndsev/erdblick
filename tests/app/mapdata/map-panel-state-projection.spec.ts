import "@angular/compiler";
import { BehaviorSubject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stateOwners, testPersistence } from "../../support/state-owners";
import { MapViewService } from "../../../app/mapview/mapview.service";
import type { MapPresetService } from "../../../app/mapstyle/map-preset.service";
import type { ErdblickStyle, MapStyleService } from "../../../app/mapstyle/mapstyle.service";
import { MapDataService } from "../../../app/mapdata/mapdata.service";
import { MapPanelComponent } from "../../../app/mapdata/map-panel.component";
import { layerStyleOptions, MapInfoItem, MapLayerTree, MapTreeViewNode } from "../../../app/mapdata/map.tree";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(destroy => destroy()));

function fixture() {
    const persistence = testPersistence();
    const owners = stateOwners(persistence);
    owners.viewSettings.importViews(["left"]);
    owners.layerState.setMapLayerConfig("Map", "Roads", [{ visible: false, level: 8, autoLevel: false }]);
    owners.layerState.setStyleOptionValues("Map", "Roads", "roads", "details", [true]);
    const style = {
        id: "roads", shortId: "roads", visible: true, presets: [],
        options: [{
            id: "details", label: "Details", description: "Details",
            type: "Bool", defaultValue: false, internal: false
        }],
        featureLayerStyle: { hasLayerAffinity: () => true }
    } as unknown as ErdblickStyle;
    const styles = {
        styles: new Map([[style.id, style]]),
        styleGroups: new BehaviorSubject([])
    } as unknown as MapStyleService;
    const presets = {
        presets: [], presets$: new BehaviorSubject([]),
        isAvailable: () => true, presetsForLayer: () => [], matchesPresetValues: () => false
    } as unknown as MapPresetService;
    const maps = new MapDataService(
        {} as never, persistence, styles, presets, {} as never,
        owners.layerState, owners.viewSettings, owners.inspectionState
    );
    // The runtime coordinator exists before the network catalog installs its
    // replacement tree. Its completed observer must still see refreshed caches.
    const views = new MapViewService(persistence, maps, owners.viewSettings, owners.configService);
    const metadata: MapInfoItem = {
        mapId: "Map", sourceId: "Map", stringPoolId: "Map", maxParallelJobs: 0,
        extraJsonAttachment: {}, addOn: false,
        protocolVersion: { major: 1, minor: 0, patch: 0 },
        layers: {
            Roads: {
                layerId: "Roads", type: "Features", canRead: true, canWrite: false,
                coverage: [], featureTypes: [], zoomLevels: [13],
                version: { major: 1, minor: 0, patch: 0 }
            }
        }
    };
    const tree = new MapLayerTree(
        [metadata], persistence, styles, presets, owners.viewSettings, owners.layerState
    );
    maps.maps.destroy();
    maps.maps$.next(tree);
    cleanup.push(() => tree.destroy());
    const panel = new MapPanelComponent(
        maps, views, {} as never, persistence, { registerShortcut: vi.fn() } as never,
        owners.configService, {} as never, owners.searchService, {} as never, {} as never,
        presets, styles, owners.layerState, owners.layout.state, owners.inspectionState, owners.viewSettings
    );
    cleanup.push(() => panel.subscriptions.forEach(subscription => subscription.unsubscribe()));
    const projections: MapTreeViewNode[][][] = [];
    const subscription = panel.mapTreeView$.subscribe(value => projections.push(value.nodesByView));
    cleanup.push(() => subscription.unsubscribe());
    const layer = (nodes: MapTreeViewNode[]) => nodes[0].children!.find(node => node.id === "Roads")!;
    const values = () => projections.at(-1)!.map((nodes, index) => {
        const projectedLayer = layer(nodes);
        const option = projectedLayer.children!.find(node => node.id === "details")!;
        return { ...projectedLayer.viewConfig![index], details: option.value![index] };
    });
    return { persistence, owners, maps, panel, tree, projections, layer, values };
}

describe("map panel owner projections", () => {
    it("publishes configured layer and style values for every newly added view", () => {
        const test = fixture();
        expect(test.values()).toEqual([{ visible: false, level: 8, autoLevel: false, details: true }]);

        test.panel.addView();

        expect(test.values()).toEqual([
            { visible: false, level: 8, autoLevel: false, details: true },
            { visible: false, level: 8, autoLevel: false, details: true }
        ]);
        for (const projection of test.projections) {
            projection.forEach((nodes, index) => {
                // The actual template dereferences each entry; no emitted
                // presentation may rely on a later cache refresh to supply it.
                expect(test.layer(nodes).viewConfig![index]).toBeDefined();
            });
        }
        expect(test.owners.layerState.mapLayerConfig("Map", "Roads")).toEqual([
            { visible: false, level: 8, autoLevel: false },
            { visible: false, level: 8, autoLevel: false }
        ]);
    });

    it("reprojects unchanged-count reorder using the retained logical layer and style values", () => {
        const test = fixture();
        test.panel.addView();
        const right = test.owners.viewSettings.viewIdAt(1);
        test.owners.layerState.setMapLayerConfig("Map", "Roads", [
            { visible: false, level: 8, autoLevel: false },
            { visible: true, level: 12, autoLevel: true }
        ]);
        test.owners.layerState.setStyleOptionValues("Map", "Roads", "roads", "details", [true, false]);
        test.owners.layerState.setLayerSyncOption(1, true);
        test.maps.configureTreeParameters();
        const observedDuringSync: unknown[] = [];
        const applySync = test.maps.applySyncOptionsForView.bind(test.maps);
        vi.spyOn(test.maps, "applySyncOptionsForView").mockImplementation(index => {
            // Inspect the cache before executing real synchronization: checking
            // only the final projection would miss a stale intermediate read.
            const layer = test.tree.maps.get("Map")!.layers.get("Roads")!;
            observedDuringSync.push({
                viewId: test.owners.viewSettings.viewIdAt(index),
                config: { ...layer.viewConfig[index] },
                details: layerStyleOptions(layer).find(option => option.id === "details")!.value[index]
            });
            applySync(index);
        });

        test.owners.viewSettings.importViews([right, "left"]);

        expect(test.values()).toEqual([
            { visible: true, level: 12, autoLevel: true, details: false },
            { visible: false, level: 8, autoLevel: false, details: true }
        ]);
        expect(observedDuringSync).toEqual([{
            viewId: right,
            config: { visible: true, level: 12, autoLevel: true },
            details: false
        }]);
        expect(test.owners.layerState.mapLayerConfig("Map", "Roads")).toEqual([
            { visible: true, level: 12, autoLevel: true },
            { visible: false, level: 8, autoLevel: false }
        ]);
        expect(test.owners.layerState.styleOptionValues("Map", "Roads", "roads", "details", "Bool", false))
            .toEqual([false, true]);
    });

    it("refreshes cloned controls after an external-state replacement with unchanged membership", () => {
        const test = fixture();
        test.owners.layerState.setMapLayerConfig("Map", "Roads", [{ visible: true, level: 10, autoLevel: true }]);
        test.owners.layerState.setStyleOptionValues("Map", "Roads", "roads", "details", [false]);

        test.persistence.stateApplied.next();

        expect(test.values()).toEqual([{ visible: true, level: 10, autoLevel: true, details: false }]);
    });
});
