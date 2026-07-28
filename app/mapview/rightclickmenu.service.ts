import {Injectable} from "@angular/core";
import {MenuItem} from "primeng/api";
import {BehaviorSubject, Subject} from "rxjs";
import {Color, HeightReference, Rectangle} from "../integrations/geo";
import {coreLib} from "../integrations/wasm";
import {
    AppStateService,
    SelectedSourceData,
    type TileFeatureId
} from "../shared/appstate.service";
import type {FeatureSearchMapLayerRef} from "../shared/feature-search-state";
import {FeatureSearchService} from "../search/feature.search.service";
import {InfoMessageService} from "../shared/info.service";
import {DiagnosticsFacadeService} from "../diagnostics/diagnostics.facade.service";
import {PerformanceDiagnosticsScope} from "../diagnostics/diagnostics.model";
import {
    ExternalViewerLocation,
    ExternalViewerService
} from "../search/external-viewer.service";
import type {RenderNavigationTarget} from "./render-view.model";
import {InspectionSelectionService} from "../inspection/inspection-selection.service";

/** One selectable source-data tile candidate shown in the context-menu flow. */
export interface SourceDataDropdownOption {
    id: number | string,
    name: string,
    disabled?: boolean
    tileLevel?: number;
}

/** Rectangle payload that the views use to render a temporary tile outline. */
export interface TileOutlinePayload {
    rectangle: {
        coordinates: {
            west: number;
            south: number;
            east: number;
            north: number;
        };
        [key: string]: unknown;
    };
}

/** View-local search scope prepared when the user opens the map context menu. */
export interface FeatureSearchContextMenuScope {
    viewIndex: number;
    selectedMapLayers: FeatureSearchMapLayerRef[];
}

/** One grouped tile-diagnostics action prepared for the current right-click context. */
export interface TileDiagnosticsMenuOption {
    tileId: string;
    level: number;
    layers: PerformanceDiagnosticsScope["layers"];
}

/** Transient first-person action offered by the context menu for one render view. */
export type FirstPersonViewMenuContext =
    | {viewIndex: number; active: true}
    | {viewIndex: number; active: false; target: RenderNavigationTarget};

/** View-scoped first-person request emitted when a context-menu action is selected. */
export type FirstPersonViewMenuRequest =
    | {viewIndex: number; action: "enter"; target: RenderNavigationTarget}
    | {viewIndex: number; action: "exit"};

/** One flat context-menu row retaining its topmost concrete tile hit. */
interface PickedFeatureMenuRow {
    identity: string;
    feature: TileFeatureId;
}

@Injectable()
/**
 * Owns the dynamic right-click menu content for the map view.
 * The service tracks source-data context so the menu can offer quick repeat actions across tiles.
 */
export class RightClickMenuService {

    menuItems: BehaviorSubject<MenuItem[]> = new BehaviorSubject<MenuItem[]>([]);
    preferredTileIdForSourceData: number | null = null;
    lastInspectedTileSourceDataOption: BehaviorSubject<{tileId: number, mapId: string, layerId: string} | null> =
        new BehaviorSubject<{tileId: number, mapId: string, layerId: string} | null>(null);
    closeContextMenus: Subject<void> = new Subject<void>();
    tileIdsForSourceData: Subject<SourceDataDropdownOption[]> = new Subject<SourceDataDropdownOption[]>();
    tileOutline: Subject<TileOutlinePayload | null> = new Subject<TileOutlinePayload | null>();
    customTileAndMapId: Subject<[string, string]> = new Subject<[string, string]>();
    firstPersonViewRequests: Subject<FirstPersonViewMenuRequest> = new Subject<FirstPersonViewMenuRequest>();
    private tileDiagnosticsOptions: TileDiagnosticsMenuOption[] = [];
    private sourceDataDialogVisible = false;
    private sourceDataShortcut: {tileId: number, mapId: string, layerId: string} | null = null;
    private featureSearchScope: FeatureSearchContextMenuScope | null = null;
    private externalViewerLocation: ExternalViewerLocation | null = null;
    private firstPersonViewContext: FirstPersonViewMenuContext | null = null;
    private pickedFeatureRows: PickedFeatureMenuRow[] = [];

    /** Seeds the default menu and keeps the “inspect last layer” shortcut synchronized with context. */
    constructor(private stateService: AppStateService,
                private featureSearchService: FeatureSearchService,
                private infoMessageService: InfoMessageService,
                private diagnostics: DiagnosticsFacadeService,
                private externalViewerService: ExternalViewerService,
                private inspectionSelection: InspectionSelectionService) {
        this.rebuildMenuItems();
        this.tileIdsForSourceData.subscribe(tileIds => {
            this.sourceDataShortcut = null;
            const lastOption = this.lastInspectedTileSourceDataOption.getValue();
            if (lastOption) {
                const tileId = this.preferredSourceDataTile(tileIds);
                if (tileId) {
                    this.sourceDataShortcut = {
                        tileId: Number(tileId.id),
                        mapId: lastOption.mapId,
                        layerId: lastOption.layerId
                    };
                }
            }
            this.rebuildMenuItems();
        });
    }

    /** Requests every map view to hide its PrimeNG context menu before another one opens. */
    closeAllContextMenus(): void {
        this.closeContextMenus.next();
    }

    /** Returns whether the source-data picker dialog is currently visible. */
    isSourceDataDialogOpen(): boolean {
        return this.sourceDataDialogVisible;
    }

    /** Opens the source-data picker dialog. */
    openTileSourceDataDialog(): void {
        this.sourceDataDialogVisible = true;
    }

    /** Closes the source-data picker dialog. */
    closeTileSourceDataDialog(): void {
        this.sourceDataDialogVisible = false;
    }

    /** Updates the context-menu action that starts a view-scoped feature search. */
    setFeatureSearchScope(scope: FeatureSearchContextMenuScope | null): void {
        this.featureSearchScope = scope;
        this.rebuildMenuItems();
    }

    /** Replaces the tile-scoped Performance Diagnostics entries for the current context. */
    setTileDiagnosticsOptions(options: TileDiagnosticsMenuOption[]): void {
        this.tileDiagnosticsOptions = [...options];
        this.rebuildMenuItems();
    }

    /** Sets the exact WGS84 position represented by the currently open context menu. */
    setExternalViewerLocation(location: ExternalViewerLocation | null): void {
        this.externalViewerLocation = location;
        this.rebuildMenuItems();
    }

    /** Sets the ephemeral first-person action represented by the currently open context menu. */
    setFirstPersonViewContext(context: FirstPersonViewMenuContext | null): void {
        this.firstPersonViewContext = context;
        this.rebuildMenuItems();
    }

    /** Replaces the ordered first-section rows from one bounded desktop drill-pick. */
    setPickedFeatures(features: TileFeatureId[]): void {
        const rows: PickedFeatureMenuRow[] = [];
        const seen = new Set<string>();
        for (const feature of features) {
            const [mapId, layerId] = coreLib.parseMapTileKey(feature.mapTileKey) as [
                string,
                string,
                number
            ];
            const identity = JSON.stringify([mapId, layerId, feature.featureId]);
            if (seen.has(identity)) {
                continue;
            }
            seen.add(identity);
            rows.push({identity, feature});
        }
        this.pickedFeatureRows = rows;
        this.rebuildMenuItems();
    }

    /**
     * Chooses the best source-data tile candidate for the current context.
     * Preference is: explicit user choice, last inspected level, then deepest enabled tile.
     */
    preferredSourceDataTile(tileIds: SourceDataDropdownOption[]): SourceDataDropdownOption | undefined {
        if (this.preferredTileIdForSourceData !== null) {
            const preferredTile = tileIds.find(tileId => tileId.id === this.preferredTileIdForSourceData && !tileId.disabled);
            if (preferredTile) {
                return preferredTile;
            }
        }

        const lastOption = this.lastInspectedTileSourceDataOption.getValue();
        if (lastOption) {
            const level = coreLib.getTileLevel(lastOption.tileId);
            const matchingTile = tileIds.find(tileId => tileId.tileLevel === level && !tileId.disabled);
            if (matchingTile) {
                return matchingTile;
            }
        }

        for (let index = tileIds.length - 1; index >= 0; index--) {
            const tileId = tileIds[index];
            if (!tileId.disabled) {
                return tileId;
            }
        }
        return undefined;
    }

    /** Publishes a temporary outline rectangle for a tile id, mainly for source-data picking. */
    outlineTile(tileId: number, color: Color = Color.HOTPINK) {
        const tileBox = coreLib.getTileBox(tileId);
        this.tileOutline.next({
            rectangle: {
                coordinates: Rectangle.fromDegrees(...tileBox),
                height: HeightReference.CLAMP_TO_GROUND,
                material: color.withAlpha(0.2),
                outline: true,
                outlineWidth: 3.,
                outlineColor: color
            }
        });
    }

    /** Rebuilds context-menu items from the latest source-data, diagnostics, and search scopes. */
    private rebuildMenuItems(): void {
        const items: MenuItem[] = [];
        if (this.pickedFeatureRows.length) {
            items.push(
                ...this.pickedFeatureRows.map((row, index) =>
                    this.pickedFeatureMenuItem(row, index)),
                {separator: true}
            );
        }
        items.push(...this.sourceDataMenuItems());
        if (this.firstPersonViewContext) {
            items.push({separator: true}, this.firstPersonViewMenuItem(this.firstPersonViewContext));
        }
        if (this.externalViewerLocation && this.externalViewerService.providers.length) {
            items.push({separator: true}, this.externalViewerMenuItem(this.externalViewerLocation));
        }
        if (this.tileDiagnosticsOptions.length) {
            items.push({separator: true});
            for (const option of this.tileDiagnosticsOptions) {
                items.push(this.tileDiagnosticsMenuItem(option));
            }
        }
        if (this.featureSearchScope) {
            items.push({separator: true}, this.featureSearchMenuItem(this.featureSearchScope));
        }
        this.menuItems.next(items);
    }

    /** Builds one direct feature-inspection row in rendered hit order. */
    private pickedFeatureMenuItem(row: PickedFeatureMenuRow, index: number): MenuItem {
        return {
            id: row.identity,
            automationId: `inspect-picked-feature-${index}`,
            label: row.feature.featureId,
            icon: "pi pi-search",
            command: () => this.inspectionSelection.inspectFeatureIds([row.feature])
        };
    }

    /** Builds the enter or exit first-person action for the view that opened the menu. */
    private firstPersonViewMenuItem(context: FirstPersonViewMenuContext): MenuItem {
        if (context.active) {
            return {
                label: "Exit First Person View",
                icon: "pi pi-sign-out",
                command: () => this.firstPersonViewRequests.next({
                    viewIndex: context.viewIndex,
                    action: "exit"
                })
            };
        }
        return {
            label: "Show First Person View",
            icon: "pi pi-eye",
            command: () => this.firstPersonViewRequests.next({
                viewIndex: context.viewIndex,
                action: "enter",
                target: context.target
            })
        };
    }

    /** Builds the provider submenu for the exact right-click position. */
    private externalViewerMenuItem(location: ExternalViewerLocation): MenuItem {
        return {
            label: "Open in…",
            icon: "pi pi-external-link",
            items: this.externalViewerService.providers.map(provider => ({
                label: provider.name,
                icon: "pi pi-map-marker",
                command: () => this.externalViewerService.open(provider, location)
            }))
        };
    }

    /** Returns the source-data actions for the currently prepared context. */
    private sourceDataMenuItems(): MenuItem[] {
        if (!this.sourceDataShortcut) {
            return [this.sourceDataPickerMenuItem()];
        }
        return [
            this.buildLastInspectedSourceDataMenuItem(this.sourceDataShortcut),
            this.sourceDataPickerMenuItem()
        ];
    }

    /** Builds the source-data picker action for the currently prepared tile candidates. */
    private sourceDataPickerMenuItem(): MenuItem {
        return {
            label: 'Inspect Source Data for Tile',
            icon: 'pi pi-database',
            command: () => {
                this.openTileSourceDataDialog();
            }
        };
    }

    /** Builds a shortcut that reuses the last inspected source-data layer for the current tile. */
    private buildLastInspectedSourceDataMenuItem(sourceDataParams: {tileId: number, mapId: string, layerId: string}): MenuItem {
        return {
            label: 'Inspect Source Data with Last Layer',
            icon: 'pi pi-database',
            command: () => {
                this.stateService.setSelection({
                    mapTileKey: coreLib.getSourceDataLayerKey(sourceDataParams.mapId, sourceDataParams.layerId, sourceDataParams.tileId)
                } as SelectedSourceData);
            }
        };
    }

    /** Builds a tile-scoped Performance Diagnostics action for one grouped tile option. */
    private tileDiagnosticsMenuItem(option: TileDiagnosticsMenuOption): MenuItem {
        return {
            label: `Diagnostics for Tile ${option.tileId}`,
            icon: 'pi pi-chart-line',
            command: () => {
                this.diagnostics.openPerformanceDialog({
                    tileIds: [option.tileId],
                    layers: option.layers,
                    source: 'context-menu'
                });
            }
        };
    }

    /** Returns the feature-search action for the currently prepared view scope. */
    private featureSearchMenuItem(scope: FeatureSearchContextMenuScope): MenuItem {
        const disabled = !scope.selectedMapLayers.length;
        return {
            label: disabled ? 'No loaded feature data in this view' : 'Search all features in this view',
            icon: 'pi pi-search',
            disabled,
            command: () => {
                if (!scope.selectedMapLayers.length) {
                    return;
                }
                this.featureSearchService.run("true", {
                    selectedMapLayers: scope.selectedMapLayers,
                    selectedViewIndices: [scope.viewIndex],
                    selectedMapLayersManual: true
                });
                this.infoMessageService.showInfo("Started search in this view");
            }
        };
    }
}
