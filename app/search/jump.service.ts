import {inject, Injectable} from "@angular/core";
import {HighlightMode} from "build/libs/core/erdblick-core";
import {BehaviorSubject, Subject} from "rxjs";
import {z} from "zod";
import {rejectAction} from "../actions/action-utils";
import {ActionDeclaration, AppActionService} from "../actions/app-action.service";
import type {SearchTarget} from "../actions/omnibar";
import {parsePackedTileId} from "../coords/nds-coordinate.util";
import {InspectionSelectionService} from "../inspection/inspection-selection.service";
import {SelectedSourceData, TileFeatureId} from "../inspection/inspection-state.model";
import {InspectionStateService} from "../inspection/inspection-state.service";
import {coreLib} from "../integrations/wasm";
import {MapInfoService} from "../mapdata/map-info.service";
import {MapViewStateService} from "../mapview/map-view-state.service";
import {RightClickMenuService} from "../mapview/rightclickmenu.service";
import {viewIdentitySchema} from "../mapview/view-id";
import {AppConfigService} from "../shared/app-config.service";
import {AppStateService} from "../shared/appstate.service";
import {InfoMessageService} from "../shared/info.service";
import {CoordinateJumpService} from "./coordinate-jump.service";
import {FeatureSearchService} from "./feature.search.service";
export {normalizeSearchJumpResult} from "../actions/omnibar";
export type {SearchJump, SearchJumpResult, SearchTarget} from "../actions/omnibar";

export const FEATURE_SEARCH_TARGET_ID = "features";

/**
 * Response shape returned by the backend /locate endpoint for jump-target resolution.
 */
interface LocateResponse {
    responses: Array<
        Array<{
            tileId: string;
            typeId: string;
            featureId: Array<string>;
        }>
    >;
}

/**
 * Core-lib jump-target description parsed from a feature id expression.
 */
interface FeatureJumpAction {
    id: string;
    name: string;
    error: string | null;
    idParts: Array<{key: string; value: string | number}>;
    maps: Array<string>;
}

@Injectable({providedIn: "root"})
/**
 * Builds and executes the action list shown by the global search panel.
 *
 * The service merges static actions, feature-derived jump targets, plugin-provided actions,
 * and the temporary map-selection flow used when a feature can exist in multiple maps.
 */
export class JumpTargetService {
    static readonly actions = {
        inspectSource: {
            name: "omnibar_source_data",
            description: "Inspect a packed tile's source data using the current map catalog.",
            mutation: true,
            exposure: "omnibar",
            inputSchema: z.object({query: z.string().min(1).max(8192)}).strict(),
            outputSchema: z.void()
        },
        jumpFeature: {
            name: "omnibar_feature_jump",
            description: "Locate a current feature composition and navigate to the captured view.",
            mutation: true,
            exposure: "omnibar",
            inputSchema: z
                .object({
                    compositionId: z.string().min(1),
                    query: z.string().min(1).max(8192),
                    target: viewIdentitySchema
                })
                .strict(),
            outputSchema: z.void()
        },
        runPlugin: {
            name: "omnibar_jump_plugin",
            description: "Run a currently configured jump provider after revalidating its input and view.",
            mutation: true,
            exposure: "omnibar",
            inputSchema: z
                .object({
                    pluginId: z.string().min(1),
                    query: z.string().max(8192),
                    payload: z.unknown().optional(),
                    target: viewIdentitySchema
                })
                .strict(),
            outputSchema: z.void()
        }
    } as const satisfies Record<string, ActionDeclaration>;
    private readonly actions = inject(AppActionService);
    private readonly coordinates = inject(CoordinateJumpService);

    readonly viewStateOwner = inject(MapViewStateService);
    readonly inspectionState = inject(InspectionStateService);

    markedPosition: Subject<Array<number>> = new Subject<Array<number>>();
    targetValueSubject = new BehaviorSubject<string>("");
    jumpTargets = new BehaviorSubject<Array<SearchTarget>>([]);
    extJumpTargets: Array<SearchTarget> = [];
    searchIsFocused: boolean = false;

    // Communication channels with the map selection dialog (in SearchPanelComponent).
    // The mapSelectionSubject triggers the display of the dialog, and
    // the setSelectedMap promise resolver is used by the dialog to communicate the
    // user's choice.
    mapSelectionSubject = new Subject<Array<string>>();
    setSelectedMap: ((choice: string | null) => void) | null = null;
    private initialized = false;

    /**
     * Loads optional jump-target plugins and wires the reactive channels used by the search UI.
     */
    constructor(
        private mapService: MapInfoService,
        private inspectionSelection: InspectionSelectionService,
        private messageService: InfoMessageService,
        private menuService: RightClickMenuService,
        private stateService: AppStateService,
        private searchService: FeatureSearchService,
        private configService: AppConfigService
    ) {
        this.actions.registerAction(JumpTargetService.actions.inspectSource, ({query}) => {
            if (!this.getInspectTileSourceDataTarget(query).validate(query))
                rejectAction("Source-data input is no longer valid", "not_available");
            this.inspectTileSourceData(query);
        });
        this.actions.registerAction(JumpTargetService.actions.jumpFeature, async ({compositionId, query, target}) => {
            const current = (
                this.mapService.tileLayerParser.filterFeatureJumpTargets(query) as FeatureJumpAction[]
            ).find((candidate) => candidate.id === compositionId && !candidate.error);
            if (!current) rejectAction("Feature jump is no longer available", "not_available");
            const index = this.viewStateOwner.requireCurrentView(target);
            await this.highlightByJumpTarget(current, null, coreLib.HighlightMode.SELECTION_HIGHLIGHT, index);
        });
        this.actions.registerAction(JumpTargetService.actions.runPlugin, async ({pluginId, query, payload, target}) => {
            this.viewStateOwner.requireCurrentView(target);
            const provider = this.extJumpTargets.find((candidate) => candidate.id === pluginId);
            if (!provider || !provider.validate(query))
                rejectAction("Jump provider is no longer available", "not_available");
            if (provider.jump) {
                const result = await provider.jump(query, payload);
                this.viewStateOwner.requireCurrentView(target);
                if (!this.extJumpTargets.includes(provider))
                    rejectAction("Jump provider is no longer available", "not_available");
                this.coordinates.navigate(result, target);
            } else {
                await provider.execute?.(query, payload);
            }
        });
        this.actions.registerOmnibar("feature-and-plugin-jumps", (query) => this.getJumpTargetsForValue(query), 10);

        // Forward point selections to the persisted marker owner.
        this.markedPosition.subscribe((position) => {
            if (position.length >= 2) {
                this.viewStateOwner.setMarkerControl({
                    enabled: true,
                    position: {lon: position[1], lat: position[0], alt: position[2] ?? 0}
                });
            }
        });
    }

    /** The parser and configured plugins become available after core and map data startup. */
    initialize(): void {
        if (this.initialized) return;
        this.initialized = true;
        this.loadConfiguredJumpTargets();
        this.targetValueSubject.subscribe(() => this.update());
    }

    /** Loads optional jump-target plugins declared in the shared frontend config. */
    private loadConfiguredJumpTargets() {
        const jumpTargetsConfig = this.configService.getExtensionModuleId("jumpTargets");
        if (!jumpTargetsConfig) {
            return;
        }

        const jumpTargetsPath = `/static-config/${jumpTargetsConfig}.js`;
        this.loadJumpTargetsModule(jumpTargetsPath)
            .then((plugin) => plugin.default() as Array<SearchTarget>)
            .then((jumpTargets: Array<SearchTarget>) => {
                this.extJumpTargets = this.validatePluginJumpTargets(jumpTargets);
                this.update();
            })
            .catch((error) => {
                console.error(error);
            });
    }

    private validatePluginJumpTargets(jumpTargets: Array<SearchTarget>): Array<SearchTarget> {
        if (!Array.isArray(jumpTargets)) {
            throw new Error("Jump-target plugin must return an array.");
        }
        const seenIds = new Set<string>();
        for (const target of jumpTargets) {
            if (!target || typeof target.id !== "string" || !target.id.trim()) {
                throw new Error(
                    `Jump-target plugin returned a target without a stable id: ${target?.name ?? "<unnamed>"}`
                );
            }
            if (seenIds.has(target.id)) {
                throw new Error(`Duplicate jump-target plugin id: ${target.id}`);
            }
            seenIds.add(target.id);
        }
        return jumpTargets;
    }

    /**
     * Returns the dynamic action that runs a simfil query across the currently loaded tiles.
     */
    getFeatureMatchTarget(searchString: string = this.targetValueSubject.getValue()): SearchTarget {
        let simfilError = "";
        try {
            coreLib.validateSimfilQuery(searchString);
        } catch (e: any) {
            const parsingError = e.message.split(": ");
            simfilError = parsingError.length > 1 ? parsingError.slice(1).join(": ") : parsingError[0];
        }
        let label = "Match features with a filter expression";
        if (simfilError) {
            label += `<br><span class="search-option-warning">${simfilError}</span>`;
        }
        const target = this.viewStateOwner.captureView(this.viewStateOwner.focusedView)!;
        return this.actions.candidate(FeatureSearchService.omnibarActions.run, {
            id: FEATURE_SEARCH_TARGET_ID,
            icon: "pi-bolt",
            color: "blue",
            name: "Search Features and Attributes",
            label: label,
            enabled: false,
            arguments: (query, payload) => ({query, payload, target}),
            isCurrent: () => this.viewStateOwner.isCurrent(target),
            saveToHistory: () => true,
            validate: (_: string) => {
                return !simfilError;
            }
        });
    }

    /** Accepts only valid signed NDS.Live packed tile ids without embedded whitespace. */
    validatePackedTileId(value: string) {
        return parsePackedTileId(value) !== undefined;
    }

    /**
     * Builds the source-data inspection action for inputs of the form tileId [mapId] [sourceLayerId].
     *
     * The parser accepts quoted map and layer ids because both may contain spaces.
     */
    getInspectTileSourceDataTarget(searchString: string = this.targetValueSubject.getValue()) {
        let label = "packedTileId = ? | (mapId = ?) | (sourceLayerId = ?)";
        let valid = true;

        const matches = this.matchSourceDataElements(searchString);
        if (matches) {
            const [tileId, mapId, sourceLayerId] = matches;
            label = `packedTileId = ${tileId}`;
            if (mapId) {
                label = `${label} | mapId = ${mapId}`;
                if (sourceLayerId) {
                    label = `${label} | sourceLayerId = ${sourceLayerId}`;
                } else {
                    label = `${label} | (sourceLayerId = ?)`;
                }
            } else {
                label = `${label} | (mapId = ?) | (sourceLayerId = ?)`;
            }

            if (matches.length > 1 && matches[1]) {
                if (!this.mapService.maps.maps.has(matches[1])) {
                    label += `<br><span class="search-option-warning">Map ID not found.</span>`;
                    valid = false;
                }
            }

            if (matches.length == 3 && matches[2]) {
                if (!this.mapService.sourceDataLayerIdForLayerName(matches[2])) {
                    label += `<br><span class="search-option-warning">SourceData layer ID not found.</span>`;
                    valid = false;
                }
            }

            valid &&= this.validatePackedTileId(matches[0].toString());
        } else {
            valid = false;
        }

        return this.actions.candidate(JumpTargetService.actions.inspectSource, {
            id: "source-data",
            icon: "pi-database",
            color: "red",
            name: "Inspect Tile Layer Source Data",
            label: label,
            enabled: false,
            arguments: (query) => ({query}),
            isCurrent: () => true,
            saveToHistory: () => true,
            validate: (_: string) => {
                return valid;
            }
        });
    }

    private matchSourceDataElements(value: string): [number, string, string] | null {
        const regex =
            /^\s*(-?\d+)(?:\s+"([^"]+)"|\s+([^\s,;"]+(?:\\\s[^\s,;"]+)*))?(?:\s+"([^"]+)"|\s+([^\s,;"]+(?:\\\s[^\s,;"]+)*))?\s*$/;
        const match = value.match(regex);
        let tileId: number;
        let mapId = "";
        let sourceLayerId = "";

        if (match) {
            const [_, tileIdStr, quoted1, unquoted1, quoted2, unquoted2] = match;
            const packedTileId = parsePackedTileId(tileIdStr);
            if (!packedTileId) {
                return null;
            }
            tileId = packedTileId.value;

            if (quoted1 || unquoted1) {
                mapId = (quoted1 ? quoted1 : unquoted1).replace(/\\ /g, " ");
                if (mapId.startsWith('"') || mapId.startsWith("'")) {
                    mapId = mapId.slice(1, -1);
                }
                if (mapId.endsWith('"') || mapId.endsWith("'")) {
                    mapId = mapId.slice(1, -1);
                }
            }
            if (quoted2 || unquoted2) {
                sourceLayerId = (quoted2 ? quoted2 : unquoted2).replace(/\\ /g, " ");
                if (sourceLayerId.startsWith('"') || sourceLayerId.startsWith("'")) {
                    sourceLayerId = sourceLayerId.slice(1, -1);
                }
                if (sourceLayerId.endsWith('"') || sourceLayerId.endsWith("'")) {
                    mapId = sourceLayerId.slice(1, -1);
                }
            }
        } else {
            return null;
        }

        return [tileId, mapId, sourceLayerId];
    }

    private inspectTileSourceData(value: string): void {
        const matches = this.matchSourceDataElements(value);
        if (matches) {
            let [tileId, mapId, sourceLayerId] = matches;
            try {
                if (tileId) {
                    if (mapId) {
                        if (sourceLayerId) {
                            sourceLayerId = this.mapService.sourceDataLayerIdForLayerName(sourceLayerId) || "";
                            if (sourceLayerId) {
                                this.inspectionState.setSelection({
                                    mapTileKey: coreLib.getSourceDataLayerKey(mapId, sourceLayerId, tileId)
                                } as SelectedSourceData);
                            } else {
                                this.menuService.customTileAndMapId.next([String(tileId), mapId]);
                            }
                        } else {
                            this.menuService.customTileAndMapId.next([String(tileId), mapId]);
                        }
                    } else {
                        this.menuService.customTileAndMapId.next([String(tileId), ""]);
                    }
                }
            } catch (e) {
                this.messageService.showError(String(e));
            }
        }
    }

    /**
     * Loads the configured jump-target plugin bundle from /config at runtime.
     */
    private loadJumpTargetsModule(jumpTargetsPath: string) {
        return import(/* @vite-ignore */ jumpTargetsPath);
    }

    /**
     * Recomputes the active search targets whenever the query string or plugin state changes.
     */
    getJumpTargetsForValue(value: string): Array<SearchTarget> {
        const target = this.viewStateOwner.captureView(this.viewStateOwner.focusedView)!;
        const compositions = this.mapService.tileLayerParser.filterFeatureJumpTargets(value) as FeatureJumpAction[];
        const featureTargets = (compositions ?? []).map((composition) => {
            let label = composition.idParts.map((part) => `${part.key}=${part.value}`).join(" | ");
            if (composition.error) label += `<br><span class="search-option-warning">${composition.error}</span>`;
            return this.actions.candidate(JumpTargetService.actions.jumpFeature, {
                id: `fj:${composition.id}`,
                icon: "pi-arrow-down-left-and-arrow-up-right-to-center",
                color: "orange",
                name: `Jump to ${composition.name}`,
                label,
                enabled: !composition.error,
                arguments: (query) => ({compositionId: composition.id, query, target}),
                validate: () => !composition.error,
                isCurrent: () => this.viewStateOwner.isCurrent(target),
                saveToHistory: () => true
            });
        });
        const plugins = this.extJumpTargets.map((provider) => {
            const {execute, jump, ...presentation} = provider;
            return this.actions.candidate(JumpTargetService.actions.runPlugin, {
                ...presentation,
                arguments: (query, payload) => ({pluginId: provider.id, query, payload, target}),
                isCurrent: () => this.viewStateOwner.isCurrent(target) && this.extJumpTargets.includes(provider),
                saveToHistory: provider.saveToHistory ?? (() => true)
            });
        });
        return [
            this.getFeatureMatchTarget(value),
            this.getInspectTileSourceDataTarget(value),
            ...featureTargets,
            ...plugins
        ];
    }

    update() {
        this.jumpTargets.next(this.getJumpTargetsForValue(this.targetValueSubject.getValue()));
    }

    /**
     * Resolves a raw feature id expression to the first valid jump action and executes it.
     */
    async highlightByJumpTargetFilter(
        mapId: string,
        featureId: string,
        mode: HighlightMode = coreLib.HighlightMode.SELECTION_HIGHLIGHT,
        cameraMoveViewIndex?: number
    ) {
        let featureJumpTargets = this.mapService.tileLayerParser.filterFeatureJumpTargets(
            featureId
        ) as Array<FeatureJumpAction>;
        const validIndex = featureJumpTargets.findIndex((action) => !action.error);
        if (validIndex == -1) {
            console.error(`Error highlighting ${featureId}!`);
            return;
        }
        await this.highlightByJumpTarget(featureJumpTargets[validIndex], mapId, mode, cameraMoveViewIndex);
    }

    /**
     * Locates a specific feature, applies the requested highlight mode, and optionally moves the camera.
     *
     * If multiple maps are possible, the method waits for the search panel to provide a user choice first.
     */
    async highlightByJumpTarget(
        action: FeatureJumpAction,
        mapId?: string | null,
        mode: HighlightMode = coreLib.HighlightMode.SELECTION_HIGHLIGHT,
        cameraMoveViewIndex?: number
    ) {
        const target =
            cameraMoveViewIndex === undefined ? undefined : this.viewStateOwner.captureView(cameraMoveViewIndex);
        if (cameraMoveViewIndex !== undefined && !target) return;
        // Select the map.
        if (!mapId) {
            if (action.maps.length > 1) {
                let selectedMapPromise = new Promise<string | null>((resolve, _) => {
                    this.setSelectedMap = resolve;
                });
                this.mapSelectionSubject.next(action.maps);
                mapId = await selectedMapPromise;
            } else {
                mapId = action.maps[0];
            }
        }
        if (!mapId || (target && !this.viewStateOwner.isCurrent(target))) {
            return;
        }

        // Locate the feature.
        let resolveMe = {
            requests: [
                {
                    typeId: action.name,
                    mapId: mapId,
                    featureId: action.idParts.map((kv) => [kv.key, kv.value]).flat()
                }
            ]
        };
        let response = await fetch("locate", {
            body: JSON.stringify(resolveMe),
            method: "POST"
        });
        if (!response.ok) throw new Error(`Feature lookup failed (${response.status})`);
        let extRefsResolved = (await response.json()) as LocateResponse;
        if (extRefsResolved.responses[0].length < 1) {
            this.messageService.showError("Could not locate feature!");
            return;
        }
        if (target && !this.viewStateOwner.isCurrent(target)) return;
        let selectThisFeature = extRefsResolved.responses[0][0];

        // Set feature-to-select on MapService.
        const featureId = `${selectThisFeature.typeId}.${selectThisFeature.featureId.filter((_, index) => index % 2 === 1).join(".")}`;
        if (mode === coreLib.HighlightMode.SELECTION_HIGHLIGHT) {
            this.inspectionState.setSelection([
                {
                    mapTileKey: selectThisFeature.tileId,
                    featureId: featureId
                } as TileFeatureId
            ]);
        } else {
            this.inspectionSelection.setHoveredFeatures(
                [
                    {
                        mapTileKey: selectThisFeature.tileId,
                        featureId: featureId
                    }
                ],
                true
            );
        }

        // Center the camera on the feature if a view index was passed.
        if (cameraMoveViewIndex !== undefined) {
            await this.inspectionSelection.focusOnFeature(
                target ? this.viewStateOwner.indexOf(target.id) : cameraMoveViewIndex,
                {
                    featureId: featureId,
                    mapTileKey: selectThisFeature.tileId
                }
            );
        }
    }
}
