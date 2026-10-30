/**
 * Adapt application operations to the browser console and test debug API.
 * AppComponent supplies the live services; this facade is not an Angular
 * component and does not create an independent application lifetime.
 */
import { AppActionRegistry } from "./action/action-registry.service";
import { Cartographic } from "./integrations/geo.adapter";
import { coreLib, ErdblickCore_ } from "./integrations/wasm.adapter";
import { MapTileStreamService } from "./mapdata/map-tile-stream.service";
import {
    TileSubsetLayerRenderService,
    type DeckPresentationDebugSnapshot,
    type TileSubsetLayerRenderDebugSnapshot
} from "./mapview/deck/tile-subset-layer-render.service";
import { MapViewState } from "./mapview/mapview.state";
import { AppStateService } from "./appstate/appstate.service";

/** Browser-console helpers which use only supported S4E2 boundaries. */
export interface DebugWindow extends Window {
    ebDebug: ErdblickDebugApi;
}

/** Stable browser-console facade for renderer, camera, and transport diagnostics. */
export class ErdblickDebugApi {
    /** Bind supported debug operations without exposing service internals directly. */
    constructor(
        private readonly tileStream: MapTileStreamService,
        private readonly subsetRenderer: TileSubsetLayerRenderService,
        public readonly stateService: AppStateService,
        public readonly viewSettings: MapViewState,
        private readonly actions: AppActionRegistry
    ) {
    }

    /** Runs a registered owner action for console/tests, including when the remote relay is disabled. */
    executeAction(name: string, input: unknown): unknown {
        return this.actions.execute(name, input);
    }

    /** Apply one serialized camera state after validating its logical view index. */
    setCamera(viewIndex: number, cameraInfoStr: string): void {
        if (viewIndex >= this.viewSettings.numViews) {
            console.error(
                `Expected viewIndex < ${this.viewSettings.numViews}, got ${viewIndex}!`
            );
            return;
        }
        if (!cameraInfoStr) {
            console.error("Expected cameraInfoStr, got empty or undefined!");
            return;
        }
        const cameraInfo = JSON.parse(cameraInfoStr);
        const [longitude, latitude, height] = cameraInfo.position;
        this.viewSettings.setView(
            viewIndex,
            Cartographic.fromRadians(longitude, latitude, height),
            {
                heading: cameraInfo.orientation.heading,
                pitch: cameraInfo.orientation.pitch,
                roll: cameraInfo.orientation.roll
            }
        );
    }

    /** Serialize one logical view's camera in the format accepted by `setCamera`. */
    getCamera(viewIndex: number): string | undefined {
        if (viewIndex >= this.viewSettings.numViews) {
            console.error(
                `Expected viewIndex < ${this.viewSettings.numViews}, got ${viewIndex}!`
            );
            return undefined;
        }
        const destination = this.viewSettings.getCameraPosition(viewIndex);
        const position = [
            destination.longitude,
            destination.latitude,
            destination.height
        ];
        const orientation = this.viewSettings.getCameraOrientation(viewIndex);
        return JSON.stringify({ position, orientation });
    }

    /** Expose the initialized core module for deliberate low-level investigations. */
    coreLib(): ErdblickCore_ {
        return coreLib;
    }

    /** Return worker-credit, packet-admission, and render-timing diagnostics. */
    subsetRenderQueue(): TileSubsetLayerRenderDebugSnapshot {
        return this.subsetRenderer.debugSnapshot();
    }

    /** Returns persistent GPU allocation and draw-cardinality diagnostics. */
    subsetRenderPresentation(): DeckPresentationDebugSnapshot {
        return this.subsetRenderer.currentDeckPresentationDiagnostics();
    }

    /** Returns the worst recent per-view p90 Deck frame interval. */
    subsetRenderFrameTimeMs(): number {
        return this.subsetRenderer.currentFrameTimeMs();
    }

    /** Construct a canonical feature-layer key through the authoritative WASM API. */
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
            { mapTileKey, featureId }
        ]);
        if (!wrapper) {
            return { error: `Feature ${featureId} was not found in ${mapTileKey}.` };
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
            return { mapTileKey, featureId, hitCount: hits.length, hits };
        }) ?? { error: `Feature ${featureId} could not be parsed.` };
    }
}
