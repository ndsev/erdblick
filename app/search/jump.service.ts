import {Injectable} from "@angular/core";
import {BehaviorSubject, Subject} from "rxjs";
import {MapInfoService} from "../mapdata/map-info.service";
import {InspectionSelectionService} from "../inspection/inspection-selection.service";
import {InfoMessageService} from "../shared/info.service";
import {coreLib} from "../integrations/wasm";
import {FeatureSearchService} from "./feature.search.service";
import {HighlightMode} from "build/libs/core/erdblick-core";
import {RightClickMenuService} from "../mapview/rightclickmenu.service";
import {AppStateService, SelectedSourceData, TileFeatureId} from "../shared/appstate.service";
import {Cartographic, Rectangle} from "../integrations/geo";
import {AppConfigService} from "../shared/app-config.service";

/**
 * Response shape returned by the backend /locate endpoint for jump-target resolution.
 */
interface LocateResponse {
    responses: Array<Array<{
        tileId: string;
        typeId: string;
        featureId: Array<string>;
    }>>;
}

/**
 * One action offered by the omnibox-style search panel.
 *
 * Targets can either jump to a location or execute a side effect such as starting a feature search.
 */
export interface SearchTarget {
    id: string;
    icon: string;
    color: string;
    name: string;
    label: string;
    enabled: boolean;
    jump?: (value: string) => number[] | Rectangle | undefined;
    execute?: (value: string) => void;
    validate: (value: string) => boolean;
}

/**
 * Core-lib jump-target description parsed from a feature id expression.
 */
interface FeatureJumpAction {
    id: string;
    name: string;
    error: string|null;
    idParts: Array<{key: string, value: string|number}>;
    maps: Array<string>;
}

@Injectable({providedIn: 'root'})
/**
 * Builds and executes the action list shown by the global search panel.
 *
 * The service merges static actions, feature-derived jump targets, plugin-provided actions,
 * and the temporary map-selection flow used when a feature can exist in multiple maps.
 */
export class JumpTargetService {

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
    setSelectedMap: ((choice: string|null)=>void)|null = null;

    /**
     * Loads optional jump-target plugins and wires the reactive channels used by the search UI.
     */
    constructor(private mapService: MapInfoService,
                private inspectionSelection: InspectionSelectionService,
                private messageService: InfoMessageService,
                private menuService: RightClickMenuService,
                private stateService: AppStateService,
                private searchService: FeatureSearchService,
                private configService: AppConfigService) {
        this.loadConfiguredJumpTargets();

        // Filter out feature jump targets based on search value.
        this.targetValueSubject.subscribe(_ => {
            this.update();
        })

        // Forward marked cartesian position to AppStateService.
        this.markedPosition.subscribe(position => {
            if (position.length >= 2) {
                this.stateService.setMarkerState(true);
                this.stateService.setMarkerPosition(Cartographic.fromDegrees(position[1], position[0]));
            }
        });
    }

    /** Loads optional jump-target plugins declared in the shared frontend config. */
    private loadConfiguredJumpTargets() {
        const jumpTargetsConfig = this.configService.getExtensionModuleId("jumpTargets");
        if (!jumpTargetsConfig) {
            return;
        }

        const jumpTargetsPath = `/config/${jumpTargetsConfig}.js`;
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
                throw new Error(`Jump-target plugin returned a target without a stable id: ${target?.name ?? "<unnamed>"}`);
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
        let simfilError = '';
        try {
            coreLib.validateSimfilQuery(searchString);
        } catch (e: any) {
            const parsingError = e.message.split(': ');
            simfilError = parsingError.length > 1 ? parsingError.slice(1).join(": ") : parsingError[0];
        }
        let label = "Match features with a filter expression";
        if (simfilError) {
            label += `<br><span class="search-option-warning">${simfilError}</span>`;
        }
        return {
            id: "features",
            icon: "pi-bolt",
            color: "blue",
            name: "Search Loaded Features",
            label: label,
            enabled: false,
            execute: (value: string) => {
                this.searchService.run(value);
            },
            validate: (_: string) => {
                return !simfilError;
            }
        }
    }

    /**
     * Accepts only plain numeric tile ids without embedded whitespace.
     */
    validateMapgetTileId(value: string) {
        return value.trim().length > 0 && !/\s/g.test(value.trim()) && !isNaN(+value.trim());
    }

    /**
     * Builds the source-data inspection action for inputs of the form tileId [mapId] [sourceLayerId].
     *
     * The parser accepts quoted map and layer ids because both may contain spaces.
     */
    getInspectTileSourceDataTarget(searchString: string = this.targetValueSubject.getValue()) {
        let label = "tileId = ? | (mapId = ?) | (sourceLayerId = ?)";
        let valid = true;

        const matchSourceDataElements = (value: string): [bigint, string, string]|null => {
            const regex = /^\s*(\d+)(?:\s+"([^"]+)"|\s+([^\s,;"]+(?:\\\s[^\s,;"]+)*))?(?:\s+"([^"]+)"|\s+([^\s,;"]+(?:\\\s[^\s,;"]+)*))?\s*$/;
            const match = value.match(regex);
            let tileId: bigint;
            let mapId = "";
            let sourceLayerId = "";

            if (match) {
                const [_, bigintStr, quoted1, unquoted1, quoted2, unquoted2] = match;
                try {
                    tileId = BigInt(bigintStr);
                } catch {
                    return null;
                }

                if (quoted1 || unquoted1) {
                    mapId = (quoted1 ? quoted1 : unquoted1).replace(/\\ /g, ' ');
                    if (mapId.startsWith('"') || mapId.startsWith("'")) {
                        mapId = mapId.slice(1, -1);
                    }
                    if (mapId.endsWith('"') || mapId.endsWith("'")) {
                        mapId = mapId.slice(1, -1);
                    }
                }
                if (quoted2 || unquoted2) {
                    sourceLayerId = (quoted2 ? quoted2 : unquoted2).replace(/\\ /g, ' ');
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

            return [tileId, mapId, sourceLayerId]
        }

        const matches = matchSourceDataElements(searchString);
        if (matches) {
            const [tileId, mapId, sourceLayerId] = matches;
            label = `tileId = ${tileId}`;
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

            valid &&= this.validateMapgetTileId(matches[0].toString());
        }
        else {
            valid = false;
        }

        return {
            id: "source-data",
            icon: "pi-database",
            color: "red",
            name: "Inspect Tile Layer Source Data",
            label: label,
            enabled: false,
            execute: (value: string) => {
                const matches = matchSourceDataElements(value);
                if (matches) {
                    let [tileId, mapId, sourceLayerId] = matches;
                    try {
                        if (tileId) {
                            if (mapId) {
                                if (sourceLayerId) {
                                    sourceLayerId = this.mapService.sourceDataLayerIdForLayerName(sourceLayerId) || "";
                                    if (sourceLayerId) {
                                        this.stateService.setSelection({
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
            },
            validate: (_: string) => {
                return valid;
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
        let featureJumpTargets = this.mapService.tileLayerParser.filterFeatureJumpTargets(value) as Array<FeatureJumpAction>;
        let featureJumpTargetsConverted: Array<SearchTarget> = [];
        if (featureJumpTargets) {
            featureJumpTargetsConverted = featureJumpTargets.map((fjt: FeatureJumpAction) => {
                let label = fjt.idParts.map(idPart => `${idPart.key}=${idPart.value}`).join(" | ")
                if (fjt.error) {
                    label += `<br><span class="search-option-warning">${fjt.error}</span>`;
                }
                return {
                    id: `fj:${fjt.id}`,
                    icon: "pi-arrow-down-left-and-arrow-up-right-to-center",
                    color: "orange",
                    name: `Jump to ${fjt.name}`,
                    label: label,
                    enabled: !fjt.error,
                    execute: (_: string) => {
                        this.highlightByJumpTarget(fjt, null, coreLib.HighlightMode.SELECTION_HIGHLIGHT,
                            this.stateService.focusedView).then();
                    },
                    validate: (_: string) => { return !fjt.error; },
                }
            });
        }

        return [
            this.getFeatureMatchTarget(value),
            this.getInspectTileSourceDataTarget(value),
            ...featureJumpTargetsConverted,
            ...this.extJumpTargets
        ];
    }

    update() {
        this.jumpTargets.next(this.getJumpTargetsForValue(this.targetValueSubject.getValue()));
    }

    /**
     * Resolves a raw feature id expression to the first valid jump action and executes it.
     */
    async highlightByJumpTargetFilter(mapId: string, featureId: string, mode: HighlightMode = coreLib.HighlightMode.SELECTION_HIGHLIGHT, cameraMoveViewIndex?: number) {
        let featureJumpTargets = this.mapService.tileLayerParser.filterFeatureJumpTargets(featureId) as Array<FeatureJumpAction>;
        const validIndex = featureJumpTargets.findIndex(action => !action.error);
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
        cameraMoveViewIndex?: number) {
        // Select the map.
        if (!mapId) {
            if (action.maps.length > 1) {
                let selectedMapPromise = new Promise<string | null>((resolve, _) => {
                    this.setSelectedMap = resolve;
                })
                this.mapSelectionSubject.next(action.maps);
                mapId = await selectedMapPromise;
            }
            else {
                mapId = action.maps[0];
            }
        }
        if (!mapId) {
            return;
        }

        // Locate the feature.
        let resolveMe = {requests: [{
            typeId: action.name,
            mapId: mapId,
            featureId: action.idParts.map((kv) => [kv.key, kv.value]).flat()
        }]};
        let response = await fetch("locate", {
            body: JSON.stringify(resolveMe),
            method: "POST"
        }).catch((err)=>console.error(`Error during /locate call: ${err}`));
        if (!response) {
            return;
        }
        let extRefsResolved = await response.json() as LocateResponse;
        if (extRefsResolved.responses[0].length < 1) {
            this.messageService.showError("Could not locate feature!")
            return;
        }
        let selectThisFeature = extRefsResolved.responses[0][0];

        // Set feature-to-select on MapService.
        const featureId = `${selectThisFeature.typeId}.${selectThisFeature.featureId.filter((_, index) => index % 2 === 1).join('.')}`;
        if (mode === coreLib.HighlightMode.SELECTION_HIGHLIGHT) {
            this.stateService.setSelection([{
                mapTileKey: selectThisFeature.tileId,
                featureId: featureId
            } as TileFeatureId]);
        } else {
            await this.inspectionSelection.setHoveredFeatures([{
                mapTileKey: selectThisFeature.tileId,
                featureId: featureId
            }]);
        }

        // Center the camera on the feature if a view index was passed.
        if (cameraMoveViewIndex !== undefined) {
            await this.inspectionSelection.focusOnFeature(cameraMoveViewIndex, {
                featureId: featureId,
                mapTileKey: selectThisFeature.tileId,
            });
        }
    }
}
