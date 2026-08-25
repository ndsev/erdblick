import {Injectable, NgZone} from "@angular/core";
import {BehaviorSubject} from "rxjs";
import {
    MapTileStreamService,
    RetainedTileExpiryOwner
} from "../mapdata/map-tile-stream.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {
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
import {
    tileFeatureInteractionTargetsEqual
} from "../shared/tile-feature-id";

interface Wgs84Point {
    x: number;
    y: number;
    z?: number;
}

export interface MultiInspectionResult {
    foundFeatureCount: number;
    inspectedFeatureCount: number;
}

interface InspectionExpiryOwner extends RetainedTileExpiryOwner {
    key: string;
    panelId: number;
    mapTileKey: string;
    tileId: number;
    epoch: number;
    featureIds: TileFeatureId[];
}

/**
 * Owns selected and hovered feature interaction state, including focus/zoom navigation.
 */
@Injectable({providedIn: "root"})
export class InspectionSelectionService {
    readonly selectionTopic = new BehaviorSubject<InspectionPanelModel<FeatureWrapper>[]>([]);
    readonly hoverIdsTopic = new BehaviorSubject<TileFeatureId[]>([]);
    readonly selectionIdsTopic =
        new BehaviorSubject<InspectionPanelModel<TileFeatureId>[]>([]);
    /** Allows remote style filters only while an inspection-owned hover is active. */
    remoteHoverHighlightAllowed = false;

    private selectionConversionRevision = 0;
    private readonly pendingFeatureLoads = new Map<string, Promise<FeatureWrapper[]>>();
    private readonly inspectionExpiryOwners =
        new Map<string, InspectionExpiryOwner>();

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
        this.stateService.selectionState.subscribe(selected => {
            this.ngZone.run(() => this.selectionIdsTopic.next(selected));
            const revision = ++this.selectionConversionRevision;
            const pendingSelections: InspectionPanelModel<FeatureWrapper>[] = [];
            const pendingPanelUpdates: Array<{
                panel: InspectionPanelModel<FeatureWrapper>,
                selection: InspectionPanelModel<TileFeatureId>
            }> = [];
            const existingPanels = new Map(this.selectionTopic.getValue().map(panel => [panel.id, panel]));
            const featureLoads: Array<Promise<{
                selection: InspectionPanelModel<TileFeatureId>;
                features: FeatureWrapper[];
            } | null>> = [];
            for (const selection of selected) {
                const existing = existingPanels.get(selection.id);
                if (existing && featureSetsEqual(selection.features, existing.features) && deepEquals(existing.sourceData, selection.sourceData)) {
                    pendingSelections.push(existing);
                    pendingPanelUpdates.push({panel: existing, selection});
                    continue;
                }

                if (selection.sourceData || !selection.features.length) {
                    pendingSelections.push(this.runtimePanel(selection, []));
                    continue;
                }

                pendingSelections.push(this.runtimePanel(selection, [], true));
                featureLoads.push(this.loadFeaturesOnce(selection.features)
                    .then(features => ({selection, features}))
                    .catch(error => {
                        console.error(
                            `Failed to resolve inspection selection for panel ${selection.id}.`,
                            error
                        );
                        return null;
                    }));
            }

            // Publish panel shells before restricted feature loads finish so
            // docked and floating hosts can show progress immediately.
            this.ngZone.run(() => {
                pendingPanelUpdates.forEach(update => {
                    update.panel.locked = update.selection.locked;
                    update.panel.focused = update.selection.focused;
                    update.panel.color = update.selection.color;
                    update.panel.size = update.selection.size;
                    update.panel.undocked = update.selection.undocked ?? false;
                });
                this.selectionIdsTopic.next(
                    this.selectionIdsForRuntime(selected, pendingSelections)
                );
                this.selectionTopic.next(pendingSelections);
            });

            if (!featureLoads.length) {
                return;
            }
            void Promise.all(featureLoads).then(results => {
                if (revision !== this.selectionConversionRevision) {
                    return;
                }
                const resolvedByPanelId = new Map(results
                    .filter((result): result is NonNullable<typeof result> => result !== null)
                    .map(result => [result.selection.id, result]));
                const convertedSelections: InspectionPanelModel<FeatureWrapper>[] = [];
                for (const selection of selected) {
                    const existing = existingPanels.get(selection.id);
                    if (existing && featureSetsEqual(selection.features, existing.features) &&
                        deepEquals(existing.sourceData, selection.sourceData)) {
                        convertedSelections.push(existing);
                        continue;
                    }
                    if (selection.sourceData || !selection.features.length) {
                        convertedSelections.push(this.runtimePanel(selection, []));
                        continue;
                    }
                    const resolved = resolvedByPanelId.get(selection.id);
                    if (resolved?.features.length) {
                        convertedSelections.push(this.runtimePanel(selection, resolved.features));
                    }
                }

                // Restricted feature loading can complete from a transport
                // callback outside Angular. Publish the resolved model in-zone
                // so both docked and floating inspection views are checked.
                this.ngZone.run(() => {
                    this.selectionIdsTopic.next(
                        this.selectionIdsForRuntime(selected, convertedSelections)
                    );
                    this.selectionTopic.next(convertedSelections);
                });
            });
        });
        this.selectionTopic.subscribe(selectedPanels => {
            this.reconcileInspectionExpiries(
                selectedPanels.flatMap(panel => panel.features.map(feature => ({
                    panelId: panel.id,
                    feature
                })))
            );
            const selectedTargets = this.selectionIdsTopic.getValue()
                .flatMap(panel => panel.features);
            const hoverIds = this.hoverIdsTopic.getValue().filter(feature =>
                !selectedTargets.some(selected =>
                    tileFeatureInteractionTargetsEqual(feature, selected))
            );
            if (hoverIds.length !== this.hoverIdsTopic.getValue().length) {
                if (!hoverIds.length) {
                    this.remoteHoverHighlightAllowed = false;
                }
                this.hoverIdsTopic.next(hoverIds);
            }
        });
    }

    /** Builds the transient presentation model for one persisted selection panel. */
    private runtimePanel(
        selection: InspectionPanelModel<TileFeatureId>,
        features: FeatureWrapper[],
        loading = false
    ): InspectionPanelModel<FeatureWrapper> {
        return {
            id: selection.id,
            locked: selection.locked,
            focused: selection.focused,
            size: selection.size,
            features,
            sourceData: selection.sourceData,
            color: selection.color,
            undocked: selection.undocked ?? false,
            loading
        };
    }

    /** Projects runtime wrappers back to interaction ids while preserving ids for loading shells. */
    private selectionIdsForRuntime(
        selected: InspectionPanelModel<TileFeatureId>[],
        runtimePanels: InspectionPanelModel<FeatureWrapper>[]
    ): InspectionPanelModel<TileFeatureId>[] {
        const runtimeById = new Map(runtimePanels.map(panel => [panel.id, panel]));
        return selected.flatMap(selection => {
            const runtime = runtimeById.get(selection.id);
            if (!runtime) {
                return [];
            }
            return [{
                id: runtime.id,
                locked: runtime.locked,
                focused: runtime.focused,
                size: runtime.size,
                features: runtime.loading
                    ? selection.features
                    : runtime.features.map(feature => feature.key()),
                sourceData: runtime.sourceData,
                color: runtime.color,
                undocked: runtime.undocked
            }];
        });
    }

    /** Shares one in-flight restricted load across rapid panel-state emissions. */
    private loadFeaturesOnce(featureIds: TileFeatureId[]): Promise<FeatureWrapper[]> {
        const key = featureIds
            .map(feature => `${feature.mapTileKey}\u0000${feature.featureId}`)
            .sort()
            .join("\u0001");
        const pending = this.pendingFeatureLoads.get(key);
        if (pending) {
            return pending;
        }
        const request = this.tileStream.loadFeatures(featureIds).finally(() => {
            if (this.pendingFeatureLoads.get(key) === request) {
                this.pendingFeatureLoads.delete(key);
            }
        });
        this.pendingFeatureLoads.set(key, request);
        return request;
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

    /** Publishes hover ids without loading feature data; inspection hovers may opt into remote styles. */
    setHoveredFeatures(
        tileFeatureIds: (TileFeatureId | null)[],
        allowRemoteHighlight = false
    ): void {
        const requestedTargets = tileFeatureIds
            .filter((id): id is TileFeatureId => !!id);
        const selectedTargets = this.stateService.selectionState.getValue()
            .flatMap(panel => panel.features);
        const hoverTargets = requestedTargets.filter(id =>
            !selectedTargets.some(selected =>
                tileFeatureInteractionTargetsEqual(id, selected))
        );
        const remoteHighlightAllowed =
            hoverTargets.length > 0 && allowRemoteHighlight;
        if (featureSetsEqual(this.hoverIdsTopic.getValue(), hoverTargets) &&
            this.remoteHoverHighlightAllowed === remoteHighlightAllowed) {
            return;
        }
        this.remoteHoverHighlightAllowed = remoteHighlightAllowed;
        this.hoverIdsTopic.next(hoverTargets);
    }

    /** Reconciles one shared-heap handle per retained inspection tile value. */
    private reconcileInspectionExpiries(
        values: Array<{panelId: number; feature: FeatureWrapper}>
    ): void {
        const grouped = new Map<string, {
            panelId: number;
            mapTileKey: string;
            tileId: number;
            expiresAtMs: number | null;
            featureIds: TileFeatureId[];
        }>();
        for (const {panelId, feature} of values) {
            const tile = feature.featureTile;
            const key = `${panelId}:${tile.mapTileKey}`;
            const rawExpiry = Number(tile.expiresAtMs);
            const expiresAtMs = Number.isFinite(rawExpiry)
                ? rawExpiry
                : null;
            const rawTileId = Number(tile.tileId);
            const tileId = Number.isFinite(rawTileId)
                ? Math.trunc(rawTileId)
                : 0;
            let group = grouped.get(key);
            if (!group) {
                group = {
                    panelId,
                    mapTileKey: tile.mapTileKey,
                    tileId,
                    expiresAtMs,
                    featureIds: []
                };
                grouped.set(key, group);
            }
            group.featureIds.push(feature.key());
            if (expiresAtMs !== null &&
                (group.expiresAtMs === null ||
                 expiresAtMs < group.expiresAtMs)) {
                group.expiresAtMs = expiresAtMs;
            }
        }

        const retained = new Set(grouped.keys());
        for (const [key, owner] of [...this.inspectionExpiryOwners]) {
            if (!retained.has(key)) {
                this.tileStream.cancelRetainedTileExpiries?.(owner);
                this.inspectionExpiryOwners.delete(key);
            }
        }
        for (const [key, group] of grouped) {
            let owner = this.inspectionExpiryOwners.get(key);
            if (!owner) {
                owner = {
                    key,
                    panelId: group.panelId,
                    mapTileKey: group.mapTileKey,
                    tileId: group.tileId,
                    epoch: 0,
                    featureIds: [],
                    expireTiles: tokens => {
                        void this.renewInspectionOwner(owner!, tokens);
                    }
                };
                this.inspectionExpiryOwners.set(key, owner);
            }
            owner.tileId = group.tileId;
            owner.featureIds = group.featureIds;
            owner.epoch += 1;
            this.tileStream.updateRetainedTileExpiry?.(
                owner,
                owner.tileId,
                owner.epoch,
                group.expiresAtMs
            );
        }
    }

    /** Refreshes one still-retained tile and atomically replaces matching wrappers. */
    private async renewInspectionOwner(
        owner: InspectionExpiryOwner,
        tokens: ReadonlyArray<{tileId: number; valueVersion: number}>
    ): Promise<void> {
        if (this.inspectionExpiryOwners.get(owner.key) !== owner ||
            !tokens.some(token =>
                token.tileId === owner.tileId &&
                token.valueVersion === owner.epoch
            )) {
            return;
        }
        let replacements: FeatureWrapper[];
        try {
            replacements = await this.tileStream.loadFeatures(owner.featureIds);
        } catch (error) {
            console.error(
                `Failed to renew retained selection tile '${owner.mapTileKey}'.`,
                error
            );
            return;
        }
        if (this.inspectionExpiryOwners.get(owner.key) !== owner) {
            return;
        }
        const replacementById = new Map(replacements.map(feature => [
            feature.featureId,
            feature
        ]));
        this.ngZone.run(() => {
            const currentPanels = this.selectionTopic.getValue();
            const nextPanels = currentPanels.map(panel =>
                panel.id !== owner.panelId
                    ? panel
                    : {
                        ...panel,
                        features: panel.features.map(feature =>
                            feature.featureTile.mapTileKey === owner.mapTileKey
                                ? replacementById.get(feature.featureId) ?? feature
                                : feature
                        )
                    }
            );
            this.selectionTopic.next(nextPanels);
        });
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
