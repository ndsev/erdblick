import {Injectable, NgZone} from "@angular/core";
import {BehaviorSubject} from "rxjs";
import {MapTileStreamService} from "../mapdata/map-tile-stream.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {
    featureSetContains,
    featureSetsEqual,
    FeatureWrapper
} from "../mapdata/feature-inspection.model";
import {Feature} from "../../build/libs/core/erdblick-core";
import {
    AppStateService,
    InspectionPanelModel,
    SelectedSourceData,
    TileFeatureId
} from "../shared/appstate.service";
import {KeyboardService} from "../shared/keyboard.service";
import {InfoMessageService} from "../shared/info.service";
import {Cartesian3} from "../integrations/geo";
import {coreLib} from "../integrations/wasm";
import {deepEquals} from "../shared/app-state";

interface Wgs84Point {
    x: number;
    y: number;
    z?: number;
}

export interface MultiInspectionResult {
    foundFeatureCount: number;
    inspectedFeatureCount: number;
}

/**
 * Owns selected and hovered feature interaction state, including focus/zoom navigation.
 */
@Injectable({providedIn: "root"})
export class InspectionSelectionService {
    readonly hoverTopic = new BehaviorSubject<FeatureWrapper[]>([]);
    readonly selectionTopic = new BehaviorSubject<InspectionPanelModel<FeatureWrapper>[]>([]);
    readonly hoverIdsTopic = new BehaviorSubject<TileFeatureId[]>([]);
    readonly selectionIdsTopic =
        new BehaviorSubject<InspectionPanelModel<TileFeatureId>[]>([]);

    private selectionConversionRevision = 0;
    private hoverConversionRevision = 0;
    private lastHoverRequestSignature = "";

    constructor(
        private readonly stateService: AppStateService,
        private readonly tileStream: MapTileStreamService,
        private readonly viewState: MapViewStateService,
        private readonly keyboardService: KeyboardService,
        private readonly messageService: InfoMessageService,
        private readonly ngZone: NgZone
    ) {
        this.keyboardService.registerShortcut("Ctrl+j", this.zoomToFocusedInspectionPanel.bind(this));
    }

    /** Wires app-state selection projection once the tile stream can serve feature loads. */
    initialize(): void {
        this.stateService.selectionState.subscribe(async selected => {
            this.ngZone.run(() => this.selectionIdsTopic.next(selected));
            const revision = ++this.selectionConversionRevision;
            const convertedSelections: InspectionPanelModel<FeatureWrapper>[] = [];
            const pendingPanelUpdates: Array<{
                panel: InspectionPanelModel<FeatureWrapper>,
                selection: InspectionPanelModel<TileFeatureId>
            }> = [];
            const existingPanels = new Map(this.selectionTopic.getValue().map(panel => [panel.id, panel]));
            for (const selection of selected) {
                const existing = existingPanels.get(selection.id);
                if (existing && featureSetsEqual(selection.features, existing.features) && deepEquals(existing.sourceData, selection.sourceData)) {
                    convertedSelections.push(existing);
                    pendingPanelUpdates.push({panel: existing, selection});
                    continue;
                }
                let features: FeatureWrapper[];
                try {
                    features = await this.tileStream.loadFeatures(selection.features);
                } catch (error) {
                    console.error(`Failed to resolve inspection selection for panel ${selection.id}.`, error);
                    continue;
                }
                if (revision !== this.selectionConversionRevision) {
                    return;
                }
                if (selection.features.length && !features.length && !selection.sourceData) {
                    continue;
                }
                convertedSelections.push({
                    id: selection.id,
                    locked: selection.locked,
                    focused: selection.focused,
                    size: selection.size,
                    features: features,
                    sourceData: selection.sourceData,
                    color: selection.color,
                    undocked: selection.undocked ?? false
                });
            }
            if (revision !== this.selectionConversionRevision) {
                return;
            }
            // Restricted feature loading can complete from a transport
            // callback outside Angular. Publish the resolved model in-zone so
            // both docked and floating inspection views are checked.
            this.ngZone.run(() => {
                pendingPanelUpdates.forEach(update => {
                    update.panel.locked = update.selection.locked;
                    update.panel.focused = update.selection.focused;
                    update.panel.color = update.selection.color;
                    update.panel.size = update.selection.size;
                    update.panel.undocked = update.selection.undocked ?? false;
                });
                this.selectionIdsTopic.next(convertedSelections.map(panel => ({
                    id: panel.id,
                    locked: panel.locked,
                    focused: panel.focused,
                    size: panel.size,
                    features: panel.features.map(feature => feature.key()),
                    sourceData: panel.sourceData,
                    color: panel.color,
                    undocked: panel.undocked
                })));
                this.selectionTopic.next(convertedSelections);
            });
        });
        this.selectionTopic.subscribe(selectedPanels => {
            const hoveredFeatures = this.hoverTopic.getValue();
            if (hoveredFeatures.length) {
                this.hoverTopic.next(hoveredFeatures.filter(hoveredFeature =>
                    !selectedPanels.some(panel =>
                        panel.features.some(feature => feature.equals(hoveredFeature)))));
            }
            const selectedIdentities = new Set(
                this.selectionIdsTopic.getValue()
                    .flatMap(panel => panel.features)
                    .map(feature => `${feature.mapTileKey}\n${feature.featureId}`)
            );
            const hoverIds = this.hoverIdsTopic.getValue().filter(feature =>
                !selectedIdentities.has(`${feature.mapTileKey}\n${feature.featureId}`)
            );
            if (hoverIds.length !== this.hoverIdsTopic.getValue().length) {
                this.hoverIdsTopic.next(hoverIds);
            }
        });
    }

    /**
     * Opens one inspection per exact rendered-feature hit, bounded by the configured panel limit.
     * The warning reports logical features after merged-object expansion, not raw render objects.
     */
    inspectFeatureIds(
        tileFeatureIds: TileFeatureId[],
        lockNewPanels = false
    ): MultiInspectionResult {
        const featureIds = this.uniqueTileFeatureIds(tileFeatureIds);
        const foundFeatureCount = featureIds.length;
        if (!foundFeatureCount) {
            return {foundFeatureCount: 0, inspectedFeatureCount: 0};
        }

        if (foundFeatureCount === 1) {
            const currentPanels = this.stateService.selection;
            const featureAlreadyInspected = this.panelsContainFeature(currentPanels, featureIds[0]);
            const reusableFeaturePanel = currentPanels.some(panel =>
                panel.sourceData === undefined && !panel.locked
            );
            if (featureAlreadyInspected
                || reusableFeaturePanel
                || currentPanels.length < this.stateService.inspectionsLimit) {
                const panelId = this.stateService.setSelection(
                    [featureIds[0]],
                    undefined,
                    lockNewPanels
                );
                if (lockNewPanels && panelId !== undefined) {
                    this.stateService.setInspectionPanelLockedState(panelId, true);
                }
            }
        } else {
            // Match the existing merged-feature flow: preserve pinned/source-data panels and
            // create one new inspection panel for each candidate that still fits.
            this.stateService.unsetUnlockedSelections();
            let remainingSlots = Math.max(
                0,
                this.stateService.inspectionsLimit - this.stateService.selection.length
            );
            for (const featureId of featureIds) {
                if (this.panelsContainFeature(this.stateService.selection, featureId)) {
                    continue;
                }
                if (remainingSlots <= 0) {
                    break;
                }
                const panelId = this.stateService.setSelection([featureId], undefined, true);
                if (panelId !== undefined) {
                    remainingSlots -= 1;
                    if (lockNewPanels) {
                        this.stateService.setInspectionPanelLockedState(panelId, true);
                    }
                }
            }
        }

        const inspectedFeatureCount = featureIds.filter(featureId =>
            this.panelsContainFeature(this.stateService.selection, featureId)
        ).length;
        if (inspectedFeatureCount < foundFeatureCount) {
            this.messageService.showWarning(
                `Inspecting ${inspectedFeatureCount} features out of ${foundFeatureCount} found features. ` +
                "Decrease the selection or increase your max inspections limit to see more."
            );
        }
        return {foundFeatureCount, inspectedFeatureCount};
    }

    /** Deduplicates full map-tile/feature identities without changing traversal order. */
    private uniqueTileFeatureIds(tileFeatureIds: TileFeatureId[]): TileFeatureId[] {
        const result: TileFeatureId[] = [];
        const seen = new Set<string>();
        for (const featureId of tileFeatureIds) {
            const identity = `${featureId.mapTileKey}\u0000${featureId.featureId}`;
            if (seen.has(identity)) {
                continue;
            }
            seen.add(identity);
            result.push(featureId);
        }
        return result;
    }

    /** Returns whether any regular inspection panel already represents the exact feature identity. */
    private panelsContainFeature(
        panels: InspectionPanelModel<TileFeatureId>[],
        featureId: TileFeatureId
    ): boolean {
        return panels.some(panel =>
            panel.sourceData === undefined &&
            panel.features.some(existing =>
                existing.mapTileKey === featureId.mapTileKey &&
                existing.featureId === featureId.featureId
            )
        );
    }

    /** Resolves hover ids, drops duplicates against selection, and publishes the resulting hover set. */
    async setHoveredFeatures(tileFeatureIds: (TileFeatureId | null)[]) {
        const requestSignature = tileFeatureIds
            .filter((id): id is TileFeatureId => !!id)
            .map((id) => `${id.mapTileKey}/${id.featureId}`)
            .sort()
            .join("|");
        if (requestSignature === this.lastHoverRequestSignature) {
            return;
        }
        this.lastHoverRequestSignature = requestSignature;
        const selectedIdentities = new Set(
            this.stateService.selectionState.getValue()
                .flatMap(panel => panel.features)
                .map(feature => `${feature.mapTileKey}\n${feature.featureId}`)
        );
        this.hoverIdsTopic.next(
            tileFeatureIds
                .filter((id): id is TileFeatureId => !!id)
                .filter(id =>
                    !selectedIdentities.has(`${id.mapTileKey}\n${id.featureId}`)
                )
        );
        const revision = ++this.hoverConversionRevision;
        const features = await this.tileStream.loadFeatures(tileFeatureIds);
        if (revision !== this.hoverConversionRevision) {
            return;
        }
        const selectedIdentitiesAfterLocate = new Set(
            this.selectionIdsTopic.getValue()
                .flatMap(panel => panel.features)
                .map(feature => `${feature.mapTileKey}\n${feature.featureId}`)
        );
        this.hoverIdsTopic.next(features
            .map(feature => feature.key())
            .filter(feature => !selectedIdentitiesAfterLocate.has(
                `${feature.mapTileKey}\n${feature.featureId}`
            )));
        if (!features.length) {
            this.hoverTopic.next(features);
            return;
        }

        const selectedFeatures = this.selectionTopic.getValue().flatMap(panel => panel.features);
        const currentHover = this.hoverTopic.getValue();

        if (featureSetsEqual(selectedFeatures, features) || featureSetsEqual(currentHover, features)) {
            return;
        }
        if (featureSetContains(selectedFeatures, features)) {
            if (currentHover.length) {
                this.hoverTopic.next([]);
            }
            return;
        }
        this.hoverTopic.next(features);
    }

    /** Loads a feature and centers the target view on its reported center point. */
    async focusOnFeature(viewIndex: number|undefined, tileFeatureId: TileFeatureId) {
        const features = await this.tileStream.loadFeatures([tileFeatureId]);
        if (!features.length) {
            this.showErrorMessage(`Could not locate feature ${tileFeatureId.featureId} in ${tileFeatureId.mapTileKey}!`)
            return;
        }
        this.zoomToFeature(viewIndex, features[0]);
    }

    /** Moves the focused view to the inspection panel most recently focused by the user. */
    zoomToFocusedInspectionPanel() {
        const focusedPanelId = this.stateService.focusedInspectionPanelId;
        if (focusedPanelId === undefined) {
            return;
        }
        const panel = this.selectionTopic.getValue().find(candidate => candidate.id === focusedPanelId);
        if (!panel) {
            return;
        }
        const targetView = this.stateService.focusedView;
        if (panel.features.length) {
            this.zoomToFeature(targetView, panel.features[0]);
            return;
        }
        if (panel.sourceData) {
            this.zoomToSourceDataSelection(targetView, panel.sourceData);
        }
    }

    /**
     * Moves one or more views to a feature using Deck's WGS84 camera path.
     * Passing `undefined` targets every view that currently shows the feature tile.
     */
    zoomToFeature(viewIndex: number|undefined, featureWrapper: FeatureWrapper) {
        const targetViews = this.targetViewsForFeatureZoom(viewIndex, featureWrapper.featureTile);
        if (!targetViews.length) {
            return;
        }
        featureWrapper.peek((feature: Feature) => {
            const center = feature.center() as Wgs84Point;
            if (!this.isFiniteWgs84Point(center)) {
                return;
            }
            const radiusPoint = feature.boundingRadiusEndPoint() as Wgs84Point;
            const boundingRadius = this.featureBoundingRadiusMeters(center, radiusPoint);
            const altitude = this.featureZoomAltitude(center.z, boundingRadius);

            targetViews.forEach(vi =>
                this.viewState.moveToWgs84PositionTopic.next({
                    targetView: vi,
                    x: center.x,
                    y: center.y,
                    z: altitude
                }));
        });
    }

    /** Resolves the view indices affected by a feature zoom request. */
    private targetViewsForFeatureZoom(viewIndex: number|undefined, featureTile: FeatureWrapper["featureTile"]): number[] {
        if (viewIndex !== undefined) {
            return viewIndex >= 0 && viewIndex < this.stateService.numViews ? [viewIndex] : [];
        }

        const targetViews: number[] = [];
        for (let i = 0; i < this.stateService.numViews; ++i) {
            if (this.viewState.showsFeatureSearchTileInView(
                i,
                featureTile.mapName,
                featureTile.layerName,
                featureTile.tileId
            )) {
                targetViews.push(i);
            }
        }
        return targetViews.length ? targetViews : [this.stateService.focusedView];
    }

    /** Fits the target view to the tile represented by a focused source-data inspection. */
    private zoomToSourceDataSelection(viewIndex: number, sourceData: SelectedSourceData) {
        if (viewIndex < 0 || viewIndex >= this.stateService.numViews) {
            return;
        }
        const parsedKey = this.tileStream.parseMapTileKeySafe(sourceData.mapTileKey);
        if (!parsedKey) {
            return;
        }
        const [, , tileId] = parsedKey;
        const tileBox = coreLib.getTileBox(tileId) as number[];
        if (!Array.isArray(tileBox) || tileBox.length < 4) {
            return;
        }
        this.viewState.moveToRectangleTopic.next({
            targetView: viewIndex,
            rectangle: {
                west: tileBox[0],
                south: tileBox[1],
                east: tileBox[2],
                north: tileBox[3],
            }
        });
    }

    /** Validates the WGS84 point shape returned by the WASM feature bindings. */
    private isFiniteWgs84Point(point: Wgs84Point | undefined): point is Wgs84Point {
        return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
    }

    /** Computes a metric radius from two WGS84 points, falling back to zero for incomplete feature bounds. */
    private featureBoundingRadiusMeters(center: Wgs84Point, radiusPoint: Wgs84Point | undefined): number {
        if (!this.isFiniteWgs84Point(radiusPoint)) {
            return 0;
        }
        const centerCartesian = Cartesian3.fromDegrees(center.x, center.y, this.finiteHeight(center.z));
        const radiusCartesian = Cartesian3.fromDegrees(radiusPoint.x, radiusPoint.y, this.finiteHeight(radiusPoint.z));
        const radius = Cartesian3.distance(centerCartesian, radiusCartesian);
        return Number.isFinite(radius) ? radius : 0;
    }

    /** Converts feature size into a Deck camera altitude with a useful minimum for point-like features. */
    private featureZoomAltitude(centerHeight: number | undefined, boundingRadius: number): number {
        return this.finiteHeight(centerHeight) + Math.max(100, 3 * Math.max(0, boundingRadius));
    }

    /** Normalizes optional feature heights from the WASM point representation. */
    private finiteHeight(height: number | undefined): number {
        return Number.isFinite(height) ? Math.max(0, height as number) : 0;
    }

    /** Proxies an error toast. */
    private showErrorMessage(message: string) {
        this.messageService.showError(message);
    }
}
