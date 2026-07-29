import {coreLib, ErdblickCore_} from "./integrations/wasm";
import {MapTileStreamService} from "./mapdata/map-tile-stream.service";
import {
    TileSubsetLayerRenderService,
    type TileSubsetLayerRenderDebugSnapshot
} from "./mapview/deck/tile-subset-layer-render.service";
import {AppStateService} from "./shared/appstate.service";

/** Browser-console helpers which use only supported S4E2 boundaries. */
export interface DebugWindow extends Window {
    ebDebug: ErdblickDebugApi;
}

export class ErdblickDebugApi {
    constructor(
        private readonly tileStream: MapTileStreamService,
        private readonly subsetRenderer: TileSubsetLayerRenderService,
        public readonly stateService: AppStateService
    ) {
    }

    setCamera(viewIndex: number, cameraInfoStr: string): void {
        if (viewIndex >= this.stateService.numViews) {
            console.error(
                `Expected viewIndex < ${this.stateService.numViews}, got ${viewIndex}!`
            );
            return;
        }
        if (!cameraInfoStr) {
            console.error("Expected cameraInfoStr, got empty or undefined!");
            return;
        }
        const cameraInfo = JSON.parse(cameraInfoStr);
        this.stateService.setView(
            viewIndex,
            cameraInfo.position,
            {
                heading: cameraInfo.orientation.heading,
                pitch: cameraInfo.orientation.pitch,
                roll: cameraInfo.orientation.roll
            }
        );
    }

    getCamera(viewIndex: number): string | undefined {
        if (viewIndex >= this.stateService.numViews) {
            console.error(
                `Expected viewIndex < ${this.stateService.numViews}, got ${viewIndex}!`
            );
            return undefined;
        }
        const destination = this.stateService.getCameraPosition(viewIndex);
        const position = [
            destination.longitude,
            destination.latitude,
            destination.height
        ];
        const orientation = this.stateService.getCameraOrientation(viewIndex);
        return JSON.stringify({position, orientation});
    }

    coreLib(): ErdblickCore_ {
        return coreLib;
    }

    subsetRenderQueue(): TileSubsetLayerRenderDebugSnapshot {
        return this.subsetRenderer.debugSnapshot();
    }

    mapTileKey(
        mapId: string,
        layerId: string,
        tileId: string | number
    ): string {
        return coreLib.getTileFeatureLayerKey(
            mapId,
            layerId,
            Number(tileId)
        ) as string;
    }

    /** Loads one exact feature through the inspection-only restricted `/tiles` path. */
    async featureInspectionHoverSummary(
        mapTileKey: string,
        featureId: string,
        keyFilter = ""
    ): Promise<Record<string, unknown>> {
        const [wrapper] = await this.tileStream.loadFeatures([
            {mapTileKey, featureId}
        ]);
        if (!wrapper) {
            return {error: `Feature ${featureId} was not found in ${mapTileKey}.`};
        }
        return wrapper.peek(feature => {
            const root = feature.inspectionModel();
            const hits: Record<string, unknown>[] = [];
            const walk = (node: any, path: string[]): void => {
                if (!node || typeof node !== "object") {
                    return;
                }
                const nodeKey = String(node.key ?? "");
                const nextPath = [...path, nodeKey];
                if (typeof node.hoverId === "string" &&
                    (!keyFilter || nodeKey.includes(keyFilter))) {
                    hits.push({
                        key: node.key,
                        value: node.value,
                        hoverId: node.hoverId,
                        path: nextPath.join(" > ")
                    });
                }
                if (Array.isArray(node.children)) {
                    node.children.forEach((child: unknown) =>
                        walk(child, nextPath)
                    );
                }
            };
            if (Array.isArray(root)) {
                root.forEach((node: unknown) => walk(node, []));
            }
            return {mapTileKey, featureId, hitCount: hits.length, hits};
        }) ?? {error: `Feature ${featureId} could not be parsed.`};
    }
}
