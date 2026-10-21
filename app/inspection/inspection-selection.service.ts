import {inject, Injectable, NgZone} from "@angular/core";
import {BehaviorSubject, Subscription} from "rxjs";
import {z} from "zod";
import {Feature} from "../../build/libs/core/erdblick-core";
import {appliedAction, rejectAction} from "../actions/action-utils";
import {AppActionService} from "../actions/app-action.service";
import {ControlReadContext} from "../actions/control";
import {ViewerActionFailure} from "../actions/viewer-action-relay.contract";
import type {ViewerActionInput, ViewerActionOutput} from "../actions/viewer-action.contract";
import {featureIdentitySchema} from "../inspection/inspection-selection.service.declarations";
import {Cartesian3} from "../integrations/geo";
import {coreLib} from "../integrations/wasm";
import {featureSetsEqual, FeatureWrapper} from "../mapdata/feature-inspection.model";
import {MapTileStreamService, RetainedTileExpiryOwner} from "../mapdata/map-tile-stream.service";
import {parsePartition, partitionKeySuffix} from "../mapdata/partition.model";
import {TileDeliveryError} from "../mapdata/tile-diagnostics";
import {VIEW_SYNC_MOVEMENT, VIEW_SYNC_POSITION} from "../mapview/map-view-state.model";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {MapViewService} from "../mapview/map-view.service";
import type {ViewIdentity} from "../mapview/view-id";
import {ViewLayerDiagnosticsService} from "../mapview/view-layer-diagnostics.service";
import {deepEquals} from "../shared/app-state";
import {AppStateService} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";
import {KeyboardService} from "../shared/keyboard.service";
import {
    formatFeatureInspectionTarget,
    parseFeatureInspectionTarget,
    tileFeatureInteractionTargetsEqual
} from "../shared/tile-feature-id";
import {inspectionActions, inspectionControls} from "./inspection-selection.service.declarations";
import {InspectionPanelModel, SelectedSourceData, TileFeatureId} from "./inspection-state.model";
import {InspectionStateService} from "./inspection-state.service";

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
    tileId: string;
    epoch: number;
    featureIds: TileFeatureId[];
}

/**
 * Owns selected and hovered feature interaction state, including focus/zoom navigation.
 */
@Injectable({providedIn: "root"})
export class InspectionSelectionService {
    static readonly controls = inspectionControls;
    static readonly actions = inspectionActions;
    private readonly viewDiagnostics = inject(ViewLayerDiagnosticsService);

    readonly inspectionState = inject(InspectionStateService);
    readonly viewStateOwner = inject(MapViewStateService);
    readonly selectionTopic = new BehaviorSubject<InspectionPanelModel<FeatureWrapper>[]>([]);
    readonly hoverIdsTopic = new BehaviorSubject<TileFeatureId[]>([]);
    readonly selectionIdsTopic = new BehaviorSubject<InspectionPanelModel<TileFeatureId>[]>([]);
    /** Allows remote style filters only while an inspection-owned hover is active. */
    remoteHoverHighlightAllowed = false;

    private selectionConversionRevision = 0;
    private readonly pendingFeatureLoadControllers = new Map<string, AbortController>();
    private readonly pendingFeatureLoads = new Map<string, Promise<FeatureWrapper[]>>();
    private readonly inspectionExpiryOwners = new Map<string, InspectionExpiryOwner>();

    constructor(
        private readonly stateService: AppStateService,
        private readonly tileStream: MapTileStreamService,
        private readonly viewState: MapViewService,
        private readonly keyboardService: KeyboardService,
        private readonly messageService: InfoMessageService,
        private readonly ngZone: NgZone
    ) {
        this.registerControls();

        const actions = inject(AppActionService);
        actions.registerAction(InspectionSelectionService.actions.viewer_navigate, (input, context) =>
            this.navigate(input, context.signal)
        );
        actions.registerAction(InspectionSelectionService.actions.viewer_inspect, (input, context) =>
            this.inspect(input, context.signal)
        );
        actions.registerAction(InspectionSelectionService.actions.viewer_open_source_data, (input, context) =>
            this.openSourceData(input)
        );

        this.keyboardService.registerShortcut("Ctrl+j", this.zoomToFocusedInspectionPanel.bind(this));
    }

    /** Wires app-state selection projection once the tile stream can serve feature loads. */
    initialize(): void {
        this.inspectionState.selectionState.subscribe((selected) => {
            this.ngZone.run(() => this.selectionIdsTopic.next(selected));
            const revision = ++this.selectionConversionRevision;
            const demanded = new Set(selected.map((panel) => this.featureLoadKey(panel.features)));
            for (const [key, controller] of this.pendingFeatureLoadControllers) {
                if (!demanded.has(key)) {
                    controller.abort();
                    this.pendingFeatureLoadControllers.delete(key);
                    this.pendingFeatureLoads.delete(key);
                }
            }
            const pendingSelections: InspectionPanelModel<FeatureWrapper>[] = [];
            const pendingPanelUpdates: Array<{
                panel: InspectionPanelModel<FeatureWrapper>;
                selection: InspectionPanelModel<TileFeatureId>;
            }> = [];
            const existingPanels = new Map(this.selectionTopic.getValue().map((panel) => [panel.id, panel]));
            const featureLoads: Array<
                Promise<{
                    selection: InspectionPanelModel<TileFeatureId>;
                    features: FeatureWrapper[];
                } | null>
            > = [];
            for (const selection of selected) {
                const existing = existingPanels.get(selection.id);
                if (
                    existing &&
                    featureSetsEqual(selection.features, existing.features) &&
                    deepEquals(existing.sourceData, selection.sourceData)
                ) {
                    pendingSelections.push(existing);
                    pendingPanelUpdates.push({panel: existing, selection});
                    continue;
                }

                if (selection.sourceData || !selection.features.length) {
                    pendingSelections.push(this.runtimePanel(selection, []));
                    continue;
                }

                pendingSelections.push(this.runtimePanel(selection, [], true));
                featureLoads.push(
                    this.loadFeaturesOnce(selection.features)
                        .then((features) => ({selection, features}))
                        .catch((error) => {
                            console.error(`Failed to resolve inspection selection for panel ${selection.id}.`, error);
                            return null;
                        })
                );
            }

            // Publish panel shells before restricted feature loads finish so
            // docked and floating hosts can show progress immediately.
            this.ngZone.run(() => {
                pendingPanelUpdates.forEach((update) => {
                    update.panel.locked = update.selection.locked;
                    update.panel.focused = update.selection.focused;
                    update.panel.color = update.selection.color;
                    update.panel.size = update.selection.size;
                    update.panel.undocked = update.selection.undocked ?? false;
                });
                this.selectionIdsTopic.next(this.selectionIdsForRuntime(selected, pendingSelections));
                this.selectionTopic.next(pendingSelections);
            });

            if (!featureLoads.length) {
                return;
            }
            void Promise.all(featureLoads).then((results) => {
                if (revision !== this.selectionConversionRevision) {
                    return;
                }
                const resolvedByPanelId = new Map(
                    results
                        .filter((result): result is NonNullable<typeof result> => result !== null)
                        .map((result) => [result.selection.id, result])
                );
                const convertedSelections: InspectionPanelModel<FeatureWrapper>[] = [];
                for (const selection of selected) {
                    const existing = existingPanels.get(selection.id);
                    if (
                        existing &&
                        featureSetsEqual(selection.features, existing.features) &&
                        deepEquals(existing.sourceData, selection.sourceData)
                    ) {
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
                    this.selectionIdsTopic.next(this.selectionIdsForRuntime(selected, convertedSelections));
                    this.selectionTopic.next(convertedSelections);
                });
            });
        });
        this.selectionTopic.subscribe((selectedPanels) => {
            this.reconcileInspectionExpiries(
                selectedPanels.flatMap((panel) =>
                    panel.features.map((feature) => ({
                        panelId: panel.id,
                        feature
                    }))
                )
            );
            const selectedTargets = this.selectionIdsTopic.getValue().flatMap((panel) => panel.features);
            const hoverIds = this.hoverIdsTopic
                .getValue()
                .filter(
                    (feature) =>
                        !selectedTargets.some((selected) => tileFeatureInteractionTargetsEqual(feature, selected))
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
        const runtimeById = new Map(runtimePanels.map((panel) => [panel.id, panel]));
        return selected.flatMap((selection) => {
            const runtime = runtimeById.get(selection.id);
            if (!runtime) {
                return [];
            }
            return [
                {
                    id: runtime.id,
                    locked: runtime.locked,
                    focused: runtime.focused,
                    size: runtime.size,
                    features: runtime.loading ? selection.features : runtime.features.map((feature) => feature.key()),
                    sourceData: runtime.sourceData,
                    color: runtime.color,
                    undocked: runtime.undocked
                }
            ];
        });
    }

    private featureLoadKey(featureIds: TileFeatureId[]): string {
        return featureIds
            .map((feature) => `${feature.mapTileKey}\u0000${feature.featureId}`)
            .sort()
            .join("\u0001");
    }

    /** Shares one in-flight restricted load across rapid panel-state emissions. */
    private loadFeaturesOnce(featureIds: TileFeatureId[]): Promise<FeatureWrapper[]> {
        const key = this.featureLoadKey(featureIds);
        const pending = this.pendingFeatureLoads.get(key);
        if (pending) {
            return pending;
        }
        this.pendingFeatureLoadControllers.get(key)?.abort();
        const controller = new AbortController();
        this.pendingFeatureLoadControllers.set(key, controller);
        const request = this.tileStream.loadFeatures(featureIds, controller.signal).finally(() => {
            if (this.pendingFeatureLoads.get(key) === request) {
                this.pendingFeatureLoads.delete(key);
                // Keep terminal diagnostics owned by this selection until it
                // is removed or superseded, just like retained tile failures.
            }
        });
        this.pendingFeatureLoads.set(key, request);
        return request;
    }

    /**
     * Opens one inspection per exact rendered-feature hit, bounded by the configured panel limit.
     * Panel creation, locking and dock state publish together before wrapper loading begins.
     * The warning reports logical features after merged-object expansion, not raw render objects.
     */
    inspectFeatureIds(tileFeatureIds: TileFeatureId[], lockNewPanels = false): MultiInspectionResult {
        return this.stateService.transaction(() => {
            const featureIds = this.uniqueTileFeatureIds(tileFeatureIds);
            const foundFeatureCount = featureIds.length;
            if (!foundFeatureCount) {
                return {foundFeatureCount: 0, inspectedFeatureCount: 0};
            }

            if (foundFeatureCount === 1) {
                const currentPanels = this.inspectionState.selection;
                const featureAlreadyInspected = this.panelsContainFeature(currentPanels, featureIds[0]);
                const reusableFeaturePanel = currentPanels.some((panel) => panel.sourceData === undefined && !panel.locked);
                if (
                    featureAlreadyInspected ||
                    reusableFeaturePanel ||
                    currentPanels.length < this.inspectionState.inspectionsLimit
                ) {
                    const panelId = this.inspectionState.setSelection([featureIds[0]], undefined, lockNewPanels);
                    if (lockNewPanels && panelId !== undefined) {
                        this.inspectionState.setInspectionPanelLockedState(panelId, true);
                    }
                }
            } else {
                // Match the existing merged-feature flow: preserve pinned/source-data panels and
                // create one new inspection panel for each candidate that still fits.
                this.inspectionState.unsetUnlockedSelections();
                let remainingSlots = Math.max(
                    0,
                    this.inspectionState.inspectionsLimit - this.inspectionState.selection.length
                );
                for (const featureId of featureIds) {
                    if (this.panelsContainFeature(this.inspectionState.selection, featureId)) {
                        continue;
                    }
                    if (remainingSlots <= 0) {
                        break;
                    }
                    const panelId = this.inspectionState.setSelection([featureId], undefined, true);
                    if (panelId !== undefined) {
                        remainingSlots -= 1;
                        if (lockNewPanels) {
                            this.inspectionState.setInspectionPanelLockedState(panelId, true);
                        }
                    }
                }
            }

            const inspectedFeatureCount = featureIds.filter((featureId) =>
                this.panelsContainFeature(this.inspectionState.selection, featureId)
            ).length;
            if (inspectedFeatureCount < foundFeatureCount) {
                this.messageService.showWarning(
                    `Inspecting ${inspectedFeatureCount} features out of ${foundFeatureCount} found features. ` +
                        "Decrease the selection or increase your max inspections limit to see more."
                );
            }
            return {foundFeatureCount, inspectedFeatureCount};
        });
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
    private panelsContainFeature(panels: InspectionPanelModel<TileFeatureId>[], featureId: TileFeatureId): boolean {
        return panels.some(
            (panel) =>
                panel.sourceData === undefined &&
                panel.features.some(
                    (existing) =>
                        existing.mapTileKey === featureId.mapTileKey && existing.featureId === featureId.featureId
                )
        );
    }

    /** Publishes hover ids without loading feature data; inspection hovers may opt into remote styles. */
    setHoveredFeatures(tileFeatureIds: (TileFeatureId | null)[], allowRemoteHighlight = false): void {
        const requestedTargets = tileFeatureIds.filter((id): id is TileFeatureId => !!id);
        const selectedTargets = this.inspectionState.selectionState.getValue().flatMap((panel) => panel.features);
        const hoverTargets = requestedTargets.filter(
            (id) => !selectedTargets.some((selected) => tileFeatureInteractionTargetsEqual(id, selected))
        );
        const remoteHighlightAllowed = hoverTargets.length > 0 && allowRemoteHighlight;
        if (
            featureSetsEqual(this.hoverIdsTopic.getValue(), hoverTargets) &&
            this.remoteHoverHighlightAllowed === remoteHighlightAllowed
        ) {
            return;
        }
        this.remoteHoverHighlightAllowed = remoteHighlightAllowed;
        this.hoverIdsTopic.next(hoverTargets);
    }

    /** Reconciles one shared-heap handle per retained inspection tile value. */
    private reconcileInspectionExpiries(values: Array<{panelId: number; feature: FeatureWrapper}>): void {
        const grouped = new Map<
            string,
            {
                panelId: number;
                mapTileKey: string;
                tileId: string;
                expiresAtMs: number | null;
                featureIds: TileFeatureId[];
            }
        >();
        for (const {panelId, feature} of values) {
            const tile = feature.featureTile;
            const key = `${panelId}:${tile.mapTileKey}`;
            const rawExpiry = Number(tile.expiresAtMs);
            const expiresAtMs = Number.isFinite(rawExpiry) ? rawExpiry : null;
            const tileId = tile.partitionKey;
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
            if (expiresAtMs !== null && (group.expiresAtMs === null || expiresAtMs < group.expiresAtMs)) {
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
                    expireTiles: (tokens) => {
                        void this.renewInspectionOwner(owner!, tokens);
                    }
                };
                this.inspectionExpiryOwners.set(key, owner);
            }
            owner.tileId = group.tileId;
            owner.featureIds = group.featureIds;
            owner.epoch += 1;
            this.tileStream.updateRetainedTileExpiry?.(owner, owner.tileId, owner.epoch, group.expiresAtMs);
        }
    }

    /** Refreshes one still-retained tile and atomically replaces matching wrappers. */
    private async renewInspectionOwner(
        owner: InspectionExpiryOwner,
        tokens: ReadonlyArray<{
            tileId: string | number;
            valueVersion: number;
        }>
    ): Promise<void> {
        if (
            this.inspectionExpiryOwners.get(owner.key) !== owner ||
            !tokens.some((token) => token.tileId === owner.tileId && token.valueVersion === owner.epoch)
        ) {
            return;
        }
        let replacements: FeatureWrapper[];
        try {
            replacements = await this.tileStream.loadFeatures(owner.featureIds);
        } catch (error) {
            if (
                this.inspectionExpiryOwners.get(owner.key) === owner &&
                tokens.some((token) => token.valueVersion === owner.epoch)
            ) {
                if (error instanceof TileDeliveryError) {
                    this.tileStream.updateRetainedTileExpiry(owner, owner.tileId, owner.epoch, error.expiresAtMs);
                }
            }
            console.error(`Failed to renew retained selection tile '${owner.mapTileKey}'.`, error);
            return;
        }
        if (this.inspectionExpiryOwners.get(owner.key) !== owner) {
            return;
        }
        const replacementById = new Map(replacements.map((feature) => [feature.featureId, feature]));
        this.ngZone.run(() => {
            const currentPanels = this.selectionTopic.getValue();
            const nextPanels = currentPanels.map((panel) =>
                panel.id !== owner.panelId
                    ? panel
                    : {
                          ...panel,
                          features: panel.features.map((feature) =>
                              feature.featureTile.mapTileKey === owner.mapTileKey
                                  ? (replacementById.get(feature.featureId) ?? feature)
                                  : feature
                          )
                      }
            );
            this.selectionTopic.next(nextPanels);
        });
    }

    /** Loads a feature and centers the target view on its reported center point. */
    async focusOnFeature(viewIndex: number | undefined, tileFeatureId: TileFeatureId) {
        const focused = this.viewStateOwner.captureView(this.viewStateOwner.focusedView);
        const candidates =
            viewIndex === undefined
                ? this.viewStateOwner.identities()
                : [this.viewStateOwner.captureView(viewIndex)].filter((view): view is ViewIdentity => !!view);
        if (!candidates.length) return;
        this.viewState.navigationStarted.next();
        const features = await this.tileStream.loadFeatures([tileFeatureId]);
        if (!candidates.some((view) => this.viewStateOwner.isCurrent(view))) return;
        if (!features.length) {
            this.showErrorMessage(
                `Could not locate feature ${tileFeatureId.featureId} in ${tileFeatureId.mapTileKey}!`
            );
            return;
        }
        const current = candidates
            .filter((view) => this.viewStateOwner.isCurrent(view))
            .map((view) => this.viewStateOwner.indexOf(view.id));
        const targets =
            viewIndex === undefined
                ? this.targetViewsForFeatureZoom(
                      undefined,
                      features[0].featureTile,
                      current,
                      focused && this.viewStateOwner.isCurrent(focused) ? this.viewStateOwner.indexOf(focused.id) : -1
                  )
                : current;
        const target = this.featureSetZoomTarget(features.slice(0, 1));
        if (target)
            targets.forEach((targetView) => this.viewState.moveToWgs84PositionTopic.next({targetView, ...target}));
    }

    /** Moves the focused view to the inspection panel most recently focused by the user. */
    zoomToFocusedInspectionPanel() {
        const focusedPanelId = this.inspectionState.focusedInspectionPanelId;
        if (focusedPanelId === undefined) {
            return;
        }
        const panel = this.selectionTopic.getValue().find((candidate) => candidate.id === focusedPanelId);
        if (!panel) {
            return;
        }
        const targetView = this.viewStateOwner.focusedView;
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
    zoomToFeature(viewIndex: number | undefined, featureWrapper: FeatureWrapper) {
        const targetViews = this.targetViewsForFeatureZoom(viewIndex, featureWrapper.featureTile);
        if (!targetViews.length) {
            return;
        }
        const target = this.featureSetZoomTarget([featureWrapper]);
        if (target)
            targetViews.forEach((vi) => this.viewState.moveToWgs84PositionTopic.next({targetView: vi, ...target}));
    }

    /** Computes the ordinary fit target for a small explicit feature set before any camera/focus mutation. */
    featureSetZoomTarget(features: readonly FeatureWrapper[]): Wgs84Point | undefined {
        const spheres = features.flatMap(
            (wrapper) =>
                wrapper.peek((feature: Feature) => {
                    const center = feature.center() as Wgs84Point;
                    return this.isFiniteWgs84Point(center)
                        ? [{center, radius: this.featureBoundingRadiusMeters(center, feature.boundingRadiusEndPoint())}]
                        : [];
                }) ?? []
        );
        if (!spheres.length || spheres.length !== features.length) return undefined;
        if (spheres.length === 1) {
            const {center, radius} = spheres[0];
            return {x: center.x, y: center.y, z: this.featureZoomAltitude(center.z, radius)};
        }
        const reference = spheres[0].center.x;
        const center: Wgs84Point = {x: 0, y: 0, z: 0};
        for (const sphere of spheres) {
            const delta = ((sphere.center.x - reference + 540) % 360) - 180;
            center.x += reference + delta;
            center.y += sphere.center.y;
            center.z = Math.max(center.z ?? 0, this.finiteHeight(sphere.center.z));
        }
        center.x = ((center.x / spheres.length + 540) % 360) - 180;
        center.y /= spheres.length;
        const radius = Math.max(
            ...spheres.map((sphere) => this.featureBoundingRadiusMeters(center, sphere.center) + sphere.radius)
        );
        return {x: center.x, y: center.y, z: this.featureZoomAltitude(center.z, radius)};
    }

    /** Resolves the view indices affected by a feature zoom request. */
    private targetViewsForFeatureZoom(
        viewIndex: number | undefined,
        featureTile: FeatureWrapper["featureTile"],
        candidates = Array.from({length: this.viewStateOwner.numViews}, (_, index) => index),
        fallback = this.viewStateOwner.focusedView
    ): number[] {
        if (viewIndex !== undefined) {
            return viewIndex >= 0 && viewIndex < this.viewStateOwner.numViews ? [viewIndex] : [];
        }

        const targetViews: number[] = [];
        for (const i of candidates) {
            if (
                featureTile.tileId !== null &&
                this.viewState.showsFeatureSearchTileInView(
                    i,
                    featureTile.mapName,
                    featureTile.layerName,
                    featureTile.tileId
                )
            ) {
                targetViews.push(i);
            }
        }
        return targetViews.length ? targetViews : candidates.includes(fallback) ? [fallback] : [];
    }

    /** Fits the target view to the tile represented by a focused source-data inspection. */
    private zoomToSourceDataSelection(viewIndex: number, sourceData: SelectedSourceData) {
        if (viewIndex < 0 || viewIndex >= this.viewStateOwner.numViews) {
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
                north: tileBox[3]
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

    /** Resolves only explicitly requested identities; never guesses between ambiguous backend matches. */
    async resolveFeatures(
        features: Array<z.infer<typeof featureIdentitySchema>>,
        signal?: AbortSignal
    ): Promise<TileFeatureId[]> {
        const result: TileFeatureId[] = [];
        for (const feature of features) {
            signal?.throwIfAborted();
            let featureId = feature.featureId;
            if (
                feature.attributeIndex !== undefined ||
                feature.relationIndex !== undefined ||
                feature.validityIndex !== undefined
            ) {
                if (feature.attributeIndex !== undefined && feature.relationIndex !== undefined)
                    rejectAction("attributeIndex and relationIndex are mutually exclusive", "invalid_arguments");
                if (feature.attributeIndex === undefined && feature.relationIndex === undefined)
                    rejectAction("validityIndex requires attributeIndex or relationIndex", "invalid_arguments");
                const target = parseFeatureInspectionTarget(featureId);
                if (target.scope !== "feature")
                    rejectAction(
                        "Use either a suffixed featureId or numeric inspection selectors, not both",
                        "invalid_arguments"
                    );
                featureId = formatFeatureInspectionTarget(
                    feature.attributeIndex !== undefined
                        ? {
                              scope: "attribute",
                              baseFeatureId: target.baseFeatureId,
                              attributeIndex: feature.attributeIndex,
                              validityIndex: feature.validityIndex
                          }
                        : {
                              scope: "relation",
                              baseFeatureId: target.baseFeatureId,
                              relationIndex: feature.relationIndex!,
                              validityIndex: feature.validityIndex
                          }
                );
            }
            if ("mapTileKey" in feature) {
                if (
                    !this.tileStream.parseMapPartitionKeySafe(feature.mapTileKey) ||
                    !feature.mapTileKey.startsWith("Features:")
                )
                    rejectAction("Invalid feature partition key", "invalid_arguments");
                result.push({mapTileKey: feature.mapTileKey, featureId});
            } else {
                const matches = await this.tileStream.locateFeature(feature.mapId, featureId, feature.layerId, signal);
                signal?.throwIfAborted();
                if (matches.length !== 1)
                    rejectAction(
                        matches.length
                            ? "Feature identity is ambiguous; supply its partition"
                            : "Feature was not found. For a relation target, discover its owning layer using mapget_list_sources/schemaFeatureTypes; featureTypes may be reference-only. Do not bypass this failure by copying the source feature's mapTileKey into a new inspection."
                    );
                const target = parseFeatureInspectionTarget(featureId);
                result.push({
                    ...matches[0],
                    featureId: formatFeatureInspectionTarget({...target, baseFeatureId: matches[0].featureId})
                });
            }
        }
        return result.filter(
            (feature, index) =>
                result.findIndex(
                    (other) => other.mapTileKey === feature.mapTileKey && other.featureId === feature.featureId
                ) === index
        );
    }

    /** Publishes inspection shells after locate only; the existing selection owner performs asynchronous feature loading. */
    async inspect(
        input: ViewerActionInput<"viewer_inspect">,
        signal?: AbortSignal
    ): Promise<ViewerActionOutput<"viewer_inspect">> {
        if (input.color !== undefined && !input.newPanel)
            rejectAction(
                "color requires newPanel:true; use inspection.panel control to recolor an existing panel",
                "invalid_arguments"
            );
        if (input.panelId !== undefined && input.newPanel)
            rejectAction("panelId and newPanel are mutually exclusive", "invalid_arguments");
        if (input.panelId !== undefined) {
            const panel = this.inspectionState.selection.find((panel) => panel.id === input.panelId);
            if (!panel || panel.locked || panel.sourceData)
                rejectAction("An explicit target must be an existing unlocked feature panel");
        }
        // Any panel edit during feature resolution invalidates this pending inspection intent.
        let changed: boolean;
        const guard = this.inspectionState.selectionState.subscribe(() => {
            changed = true;
        });
        changed = false;
        let features: TileFeatureId[];
        try {
            features = await this.resolveFeatures(input.features, signal);
            signal?.throwIfAborted();
            if (changed) rejectAction("Inspections changed while locating the feature", "cancelled");
        } finally {
            guard.unsubscribe();
        }
        return this.ngZone.run(() => this.stateService.transaction(() => {
            let newPanelId: number | undefined;
            if (input.panelId !== undefined || input.newPanel) {
                newPanelId = this.inspectionState.setSelection(features, input.panelId, input.newPanel ?? false);
            } else this.inspectFeatureIds(features, input.lock ?? false);
            const panels = this.inspectionState.selection.filter(
                (panel) =>
                    !panel.sourceData &&
                    (!input.newPanel || panel.id === newPanelId) &&
                    panel.features.some((candidate) =>
                        features.some(
                            (feature) =>
                                candidate.mapTileKey === feature.mapTileKey && candidate.featureId === feature.featureId
                        )
                    )
            );
            if (input.lock)
                panels.forEach((panel) => this.inspectionState.setInspectionPanelLockedState(panel.id, true));
            if (input.color !== undefined)
                panels.forEach((panel) => this.inspectionState.setInspectionPanelColor(panel.id, input.color!));
            const represented = features.filter((feature) =>
                panels.some((panel) =>
                    panel.features.some(
                        (candidate) =>
                            candidate.mapTileKey === feature.mapTileKey && candidate.featureId === feature.featureId
                    )
                )
            );
            return {
                status: "applied",
                panelIds: panels.map((panel) => panel.id),
                features: represented,
                complete: represented.length === features.length,
                ...(represented.length < features.length ? {reason: "item_limit" as const} : {})
            };
        }));
    }

    /** Owns cancellation only until the camera commit; human edits, layout changes and retired renderers win. */
    async navigate(
        input: ViewerActionInput<"viewer_navigate">,
        signal?: AbortSignal
    ): Promise<ViewerActionOutput<"viewer_navigate">> {
        const intended = this.viewStateOwner.requireView(input.viewId);
        const sync =
            this.viewStateOwner.viewSync.includes(VIEW_SYNC_POSITION) ||
            this.viewStateOwner.viewSync.includes(VIEW_SYNC_MOVEMENT);
        const affected = sync ? this.viewStateOwner.identities() : [intended];
        const renderers = affected.map((view) => this.viewState.renderViewFor(this.viewStateOwner.indexOf(view.id)));
        if (renderers.some((view) => !view || view.isFirstPersonViewActive()))
            rejectAction("Map navigation requires an available map camera");
        if (renderers.some((view) => view!.isCameraInteractionActive()))
            rejectAction("A human camera gesture is active", "busy");
        this.viewState.navigationStarted.next();
        const controller = new AbortController();
        const abort = () =>
            controller.abort(
                new ViewerActionFailure({
                    code: "cancelled",
                    message: "Navigation was interrupted",
                    outcome: "not_applied"
                })
            );
        signal?.addEventListener("abort", abort, {once: true});
        if (signal?.aborted) abort();
        const guards = new Subscription();
        guards.add(this.viewState.navigationStarted.subscribe(abort));
        const poses = renderers.map((view) => view!.getLiveCameraState());
        const syncBefore = this.viewStateOwner.viewSync;
        guards.add(
            this.viewDiagnostics.cameraInteracting$.subscribe((active) => {
                if (active && renderers.some((view) => view!.isCameraInteractionActive())) abort();
            })
        );
        guards.add(
            this.viewStateOwner.cameraViewDataState.appState.subscribe(() => {
                if (
                    affected.some(
                        (view, offset) =>
                            !this.viewStateOwner.isCurrent(view) ||
                            !deepEquals(renderers[offset]?.getLiveCameraState(), poses[offset])
                    )
                )
                    abort();
            })
        );
        guards.add(
            this.viewStateOwner.viewIdsState.subscribe((ids) => {
                if (
                    affected.some((view) => !this.viewStateOwner.isCurrent(view)) ||
                    (sync && ids.length !== affected.length)
                )
                    abort();
            })
        );
        guards.add(
            this.viewStateOwner.viewSyncState.subscribe((value) => {
                if (!deepEquals(value, syncBefore)) abort();
            })
        );
        for (const view of renderers) guards.add(view!.rendererInvalidated.subscribe(abort));
        try {
            const target = input.target;
            const features =
                "features" in target ? await this.resolveFeatures(target.features, controller.signal) : undefined;
            const loaded = features ? await this.tileStream.loadFeatures(features, controller.signal) : undefined;
            controller.signal.throwIfAborted();
            const viewIndex = this.viewStateOwner.requireCurrentView(intended);
            if (features && loaded?.length !== features.length)
                rejectAction("Some requested features could not be loaded");
            const position = loaded ? this.featureSetZoomTarget(loaded) : undefined;
            if (loaded && !position) rejectAction("Some requested features have no usable geometry extent");
            let bounds: {west: number; south: number; east: number; north: number} | undefined;
            if ("bounds" in target) bounds = target.bounds;
            if ("mapTileKey" in target) {
                const parsed = this.tileStream.parseMapPartitionKeySafe(target.mapTileKey);
                if (!parsed || parsed[2].kind !== "tile")
                    rejectAction("Tile fitting requires a tile partition", "invalid_arguments");
                const box = coreLib.getTileBox(parsed[2].id);
                bounds = {west: box[0], south: box[1], east: box[2], north: box[3]};
            }
            if (bounds && (bounds.west >= bounds.east || bounds.south >= bounds.north))
                rejectAction("Bounds must have positive extent and not cross the antimeridian", "invalid_arguments");
            // No asynchronous work follows this point. Unsubscribe before our own camera notification.
            guards.unsubscribe();
            return this.ngZone.run(() => {
                controller.signal.throwIfAborted();
                this.viewStateOwner.focusedView = viewIndex;
                if (position) this.viewState.moveToWgs84PositionTopic.next({targetView: viewIndex, ...position});
                else this.viewState.moveToRectangleTopic.next({targetView: viewIndex, rectangle: bounds!});
                return appliedAction();
            });
        } finally {
            guards.unsubscribe();
            signal?.removeEventListener("abort", abort);
        }
    }

    /** Uses the native key factory for backend-returned source references; the panel owns address resolution. */
    openSourceData(input: ViewerActionInput<"viewer_open_source_data">): ViewerActionOutput<"viewer_open_source_data"> {
        const source = input.source;
        if (
            !("mapTileKey" in source) &&
            source.partition.kind === "object" &&
            BigInt(source.partition.id) > 18446744073709551615n
        ) {
            rejectAction("Object partition exceeds uint64", "invalid_arguments");
        }
        const mapTileKey =
            "mapTileKey" in source
                ? source.mapTileKey
                : coreLib.createMapTileKey(
                      "SourceData",
                      source.mapId,
                      source.reference.layerId,
                      partitionKeySuffix(parsePartition(source.partition))
                  );
        const parsed = this.tileStream.parseMapPartitionKeySafe(mapTileKey);
        if (!parsed || !mapTileKey.startsWith("SourceData:"))
            rejectAction("Expected a native SourceData key", "invalid_arguments");
        const address = "mapTileKey" in source ? source.address : source.reference.address;
        if (address !== undefined && BigInt(address) > 18446744073709551615n)
            rejectAction("Address exceeds uint64", "invalid_arguments");
        const panelId = this.inspectionState.setSelection(
            {mapTileKey, ...(address === undefined ? {} : {address: BigInt(address)})},
            undefined,
            input.newPanel ?? false
        );
        if (panelId === undefined) rejectAction("An inspection could not be opened");
        return {status: "applied", panelId, mapTileKey};
    }

    private registerControls(): void {
        inject(AppActionService).registerControl(InspectionSelectionService.controls.selections, {
            read: (selector, context) => this.selectionSummary(selector.panelId, context),
            overview: () => [{}]
        });
    }

    selectionSummary(panelId: number | undefined, context: ControlReadContext) {
        const panels = this.inspectionState.selection;
        if (panelId !== undefined && !panels.some((panel) => panel.id === panelId))
            rejectAction("The inspection is unavailable");
        const runtime = new Map(this.selectionTopic.getValue().map((panel) => [panel.id, panel]));
        const selections = function* (this: InspectionSelectionService) {
            for (const panel of panels) {
                if (panelId !== undefined && panel.id !== panelId) continue;
                const features = function* (this: InspectionSelectionService) {
                    for (const feature of panel.features) {
                        const identity = this.tileStream.parseMapPartitionKeySafe(feature.mapTileKey);
                        yield identity
                            ? {...feature, mapId: identity[0], layerId: identity[1], partition: identity[2]}
                            : feature;
                    }
                }.bind(this);
                yield {
                    panelId: panel.id,
                    locked: panel.locked,
                    undocked: panel.undocked,
                    loading: panel.sourceData ? null : runtime.has(panel.id) ? !!runtime.get(panel.id)!.loading : true,
                    features: context.items(features(), 32000),
                    ...(panel.sourceData
                        ? {
                              sourceData: {
                                  mapTileKey: panel.sourceData.mapTileKey,
                                  ...(panel.sourceData.address !== undefined
                                      ? {address: panel.sourceData.address.toString()}
                                      : {})
                              }
                          }
                        : {})
                };
            }
        }.bind(this);
        return context.items(selections());
    }
}
