import {
    ChangeDetectorRef,
    Component,
    effect,
    input,
    OnDestroy,
    output,
    ViewChild
} from "@angular/core";
import {SourceDataAddressFormat} from "build/libs/core/erdblick-core";
import {AppStateService, InspectionPanelModel} from "../shared/appstate.service";
import {TreeTableNode} from "primeng/api";
import {TileSourceDataLayer} from "../../build/libs/core/erdblick-core";
import {FeatureWrapper} from "../mapdata/feature-inspection.model";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import {
    MapTileStreamClientTiles,
} from "../mapdata/tilestream";
import {MapInfoService} from "../mapdata/map-info.service";
import {Column, InspectionTreeComponent} from "./inspection.tree.component";
import {
    expandSingleChildSourceDataPaths,
    sourceDataTreePresentation
} from "./sourcedata-tree.presentation";
import {
    MapTileStreamService,
    RetainedTileExpiryOwner
} from "../mapdata/map-tile-stream.service";

interface LoadedSourceDataLayer {
    layer: TileSourceDataLayer;
    expiresAtMs: number | null;
}

@Component({
    selector: 'sourcedata-panel',
    template: `
        @if (loading) {
            <div class="spinner">
                <p-progressSpinner ariaLabel="loading"/>
            </div>
        } @else if (errorMessage) {
            <div>
                <strong>Error</strong><br>{{ errorMessage }}
            </div>
        } @else {
            @if (staleErrorMessage) {
                <div class="source-data-stale-error">
                    <strong>Refresh failed:</strong> {{ staleErrorMessage }}
                </div>
            }
            @if (sqlQuery) {
                <details class="source-data-sql-query" data-testid="source-data-sql-query">
                    <summary>SQL query</summary>
                    <code>{{ sqlQuery }}</code>
                </details>
            }
            <inspection-tree [treeData]="treeData" [columns]="columns" [panelId]="panel().id"
                             [filterText]="filterText()" (filterTextChange)="filterTextChange.emit($event)"
                             [showFilter]="showFilter()"
                             [defaultVisibleColumnKeys]="stateService.sourceDataInspectionDefaultColumns"
                             [firstHighlightedItemIndex]="firstHighlightedItemIndex">
            </inspection-tree>
        }
    `,
    standalone: false
})
/** Loads one source-data tile on demand and renders it through the shared inspection tree. */
export class SourceDataPanelComponent implements OnDestroy, RetainedTileExpiryOwner {

    panel = input.required<InspectionPanelModel<FeatureWrapper>>();
    filterText = input<string | undefined>();
    filterTextChange = output<string>();
    showFilter = input<boolean>(true);
    error = output<string>({ alias: 'errorOccurred' });

    loading: boolean = true;
    errorMessage: string = "";
    staleErrorMessage: string = "";
    sqlQuery: string | undefined;

    treeData: TreeTableNode[] = [];
    columns: Column[] = [
        { key: "key",     header: "Key",     width: '0*',    transform: (colKey, rowData) => rowData[colKey] },
        { key: "value",   header: "Value",   width: '0*',    transform: (colKey, rowData) => rowData[colKey] },
        {
            key: "displayAddress",
            header: "Address",
            width: '100px',
            transform: this.addressFormatter.bind(this),
            toggleable: true,
            toggleIcon: "numbers"
        },
        {
            key: "schemaType",
            header: "Type",
            width: 'auto',
            transform: this.schemaTypeURLFormatter.bind(this),
            toggleable: true,
            toggleIcon: "data_object"
        }
    ];

    addressFormat: SourceDataAddressFormat = coreLib.SourceDataAddressFormat.BIT_RANGE;
    firstHighlightedItemIndex: number = 0;

    @ViewChild(InspectionTreeComponent) inspectionTree?: InspectionTreeComponent;

    private loadRevision = 0;
    private valueEpoch = 0;

    constructor(private mapService: MapInfoService,
                public stateService: AppStateService,
                private tileStream: MapTileStreamService,
                private readonly cdr: ChangeDetectorRef) {
        effect(() => {
            const sourceData = this.panel().sourceData;
            const revision = ++this.loadRevision;
            this.tileStream.cancelRetainedTileExpiries?.(this);
            if (!sourceData) {
                return;
            }
            this.loading = true;
            this.treeData = [];
            this.errorMessage = "";
            this.staleErrorMessage = "";
            this.sqlQuery = undefined;
            void this.refreshSourceData(
                sourceData.mapTileKey,
                sourceData.address,
                revision,
                false
            );
        });
    }

    ngOnDestroy(): void {
        ++this.loadRevision;
        this.tileStream.cancelRetainedTileExpiries?.(this);
    }

    expireTiles(tokens: ReadonlyArray<{
        tileId: number;
        valueVersion: number;
    }>): void {
        if (!tokens.some(token => token.valueVersion === this.valueEpoch)) {
            return;
        }
        const sourceData = this.panel().sourceData;
        if (!sourceData) {
            return;
        }
        const revision = this.loadRevision;
        void this.refreshSourceData(
            sourceData.mapTileKey,
            sourceData.address,
            revision,
            true
        );
    }

    /** Keeps the current tree visible until a current replacement has parsed successfully. */
    private async refreshSourceData(
        mapTileKey: string,
        address: bigint | undefined,
        revision: number,
        renewal: boolean
    ): Promise<void> {
        let loaded: LoadedSourceDataLayer | null = null;
        try {
            loaded = await this.loadSourceDataLayer(mapTileKey);
            if (revision !== this.loadRevision) {
                return;
            }
            const root = loaded.layer.toObject();
            this.addressFormat = loaded.layer.addressFormat();
            const presentation = sourceDataTreePresentation(root);
            if (!presentation.treeData.length) {
                throw new Error(this.noSourceDataMessage(mapTileKey));
            }
            this.sqlQuery = presentation.sqlQuery;
            this.treeData = presentation.treeData;
            this.errorMessage = "";
            this.staleErrorMessage = "";
            this.selectItemWithAddress(address);
            const [, , tileId] = coreLib.parseMapTileKey(mapTileKey);
            const epoch = ++this.valueEpoch;
            this.tileStream.updateRetainedTileExpiry?.(
                this,
                Number(tileId),
                epoch,
                loaded.expiresAtMs
            );
        } catch (error) {
            if (revision !== this.loadRevision) {
                return;
            }
            const message = `${error}`;
            if (renewal && this.treeData.length) {
                this.staleErrorMessage = message;
                this.error.emit(message);
            } else {
                this.setError(message);
            }
        } finally {
            loaded?.layer.delete();
            if (revision === this.loadRevision) {
                this.loading = false;
                this.cdr.markForCheck();
            }
        }
    }

    /** Fetches and parses one source-data layer through the bounded POST /tiles endpoint. */
    async loadSourceDataLayer(mapTileKey: string) : Promise<LoadedSourceDataLayer> {
        const [mapId, layerId, tileId] = coreLib.parseMapTileKey(mapTileKey);
        if (!this.mapService.isMapLayerReady(mapId, layerId)) {
            const map = this.mapService.maps.maps.get(mapId);
            throw new Error(map
                ? this.mapService.dataSourceStatusText(map.info)
                : "Map layer is not available.");
        }
        const requests = [{
            mapId: mapId,
            layerId: layerId,
            tileIds: [Number(tileId)]
        }];

        let layer: TileSourceDataLayer | null = null;
        let expiresAtMs: number | null = null;
        const transport = new MapTileStreamClientTiles("/tiles");
        const dataSourceInfoJson = this.mapService.getDataSourceInfoJson();
        if (dataSourceInfoJson) {
            transport.setDataSourceInfoJson(dataSourceInfoJson);
        }

        transport.withSourceDataCallback((payload) => {
            const metadata = uint8ArrayToWasm((wasmBlob) =>
                transport.parser.readTileLayerMetadata(wasmBlob),
            payload) as unknown as {
                conversionTimestampMs?: number;
                ttlMs?: number;
            };
            const timestamp = Number(metadata.conversionTimestampMs);
            const ttl = Number(metadata.ttlMs);
            const expiry = Number.isFinite(timestamp) &&
                Number.isFinite(ttl) && ttl > 0
                ? timestamp + ttl
                : null;
            expiresAtMs = expiry !== null && Number.isFinite(expiry)
                ? expiry
                : null;
            const parsedLayer = uint8ArrayToWasm((wasmBlob) => {
                return transport.parser.readTileSourceDataLayer(wasmBlob);
            }, payload);
            if (!parsedLayer) {
                throw new Error(this.noSourceDataMessage(mapTileKey));
            }
            const currentLayer = layer as TileSourceDataLayer | null;
            currentLayer?.delete();
            layer = parsedLayer;
        });

        try {
            await transport.request(requests);
            if (!layer) {
                throw new Error(this.noSourceDataMessage(mapTileKey));
            }
        } catch (err) {
            const currentLayer = layer as TileSourceDataLayer | null;
            currentLayer?.delete();
            throw err instanceof Error ? err : new Error(`${err}`);
        } finally {
            transport.destroy();
        }

        const loadedLayer = layer as TileSourceDataLayer | null;
        if (!loadedLayer) {
            throw new Error(this.noSourceDataMessage(mapTileKey));
        }

        const error = loadedLayer.getError();
        if (error) {
            loadedLayer.delete();
            throw new Error(`Error while loading layer: ${error}`);
        }

        return {layer: loadedLayer, expiresAtMs};
    }

    /** Builds a user-facing empty-state message for a tile without source data. */
    private noSourceDataMessage(mapTileKey: string): string {
        const [mapId, layerId, tileId] = coreLib.parseMapTileKey(mapTileKey);
        const layerName = this.mapService.layerNameForSourceDataLayerId(String(layerId), String(layerId).startsWith("Metadata"));
        return `No source data for tile ${tileId} (${layerName}) of map ${mapId}.`;
    }

    /** Replaces the tree with an error state and notifies the parent panel. */
    setError(message: string) {
        this.loading = false;
        this.treeData = [];
        this.sqlQuery = undefined;
        this.errorMessage = message;
        this.error.emit(message);
    }

    /**
     * Returns an HTML <a> tag, with the URL pointing to the nds.live documentation
     * for the given zserio type schema.
     *
     * @param schema Zserio schema string
     * @return string HTML
     */
    /** Turns known NDS schema type names into links to the public schema documentation. */
    schemaTypeURLFormatter(colKey: string, rowData: any) {
        if (!colKey || !rowData.hasOwnProperty(colKey)) {
            return "";
        }

        const schema = rowData[colKey];
        const prefix = "https://developer.nds.live/schema/";
        const match = schema.match(/^nds\.(([^.]+\.)+)v(\d{4}_\d{2})((\.[^.]*)+)/);
        if (!match || match.length <= 4) {
            return schema;
        }

        // Sub-namespaces in front of the version get joined by "-". Names past the version get joined by "/"
        const url =
            match[1].replace(/^(.*)\.$/, "$1/").replaceAll(".", "-") +
            match[3].replaceAll("_", ".") +
            match[4].replaceAll(".", "/");
        return `<a href="${prefix + url}" target="_blank">${schema}</a>`;
    }

    /** Formats a presentation address without affecting canonical selection addresses. */
    addressFormatter(colKey: string, rowData: any): string {
        if (!colKey || !rowData.hasOwnProperty(colKey)) {
            return "";
        }
        const address = rowData[colKey];
        if (!address) {
            return "";
        }
        if (typeof address === 'object') {
            return `${address.offset}:${address.size}`
        }
        return address;
    }

    /** Expands and highlights the row that covers the requested source-data address, if present. */
    selectItemWithAddress(address?: bigint) {
        if (address === undefined) {
            expandSingleChildSourceDataPaths(this.treeData);
            this.firstHighlightedItemIndex = 0;
            return;
        }

        let addressInRange: (candidate: any) => boolean;
        if (this.addressFormat == coreLib.SourceDataAddressFormat.BIT_RANGE) {
            const searchAddress = {
                offset: address >> BigInt(32) & BigInt(0xFFFFFFFF),
                size: address & BigInt(0xFFFFFFFF),
            }

            const addressLow = searchAddress.offset;
            const addressHigh = addressLow + searchAddress.size;

            addressInRange = (candidate: any) => {
                return candidate.offset >= addressLow &&
                    candidate.offset + candidate.size <= addressHigh &&
                    (candidate.size != 0 || addressLow == addressHigh);
            }
        } else {
            addressInRange = (candidate: any) => {
                return candidate == address;
            }
        }
        // Virtual row index (visible row index) of the first highlighted row, or undefined.
        let firstHighlightedItemIndex: number | undefined;

        let select = (node: TreeTableNode, parents: TreeTableNode[], highlight: boolean, virtualRowIndex: number) => {
            if (!node.data) {
                return;
            }

            if (highlight) {
                node.data.styleClass = "highlight";
            }

            if (node.data.address && addressInRange(node.data.address)) {
                highlight = true;

                if (firstHighlightedItemIndex === undefined) {
                    firstHighlightedItemIndex = virtualRowIndex;
                }

                node.data.styleClass = "highlight";
                parents.forEach((parent: TreeTableNode) =>{
                    parent.expanded = true;
                });
            }

            if (node.children) {
                node.children.forEach((item: TreeTableNode, index) => {
                    select(item, [...parents, node], highlight, 1 + virtualRowIndex + index);
                });
            }
        };

        this.treeData.forEach((item: TreeTableNode, index) => {
            select(item, [], false, index);
        });

        this.firstHighlightedItemIndex = firstHighlightedItemIndex ?? 0;
    }

    /** Forwards layout refreshes to the shared inspection tree. */
    refreshLayout() {
        this.inspectionTree?.refreshLayout();
    }

    /** Measures the rendered content height for dock auto-sizing. */
    measurePreferredHeightEm(): number | undefined {
        return this.inspectionTree?.measurePreferredContentHeightEm();
    }

    /** Freezes the shared tree while an outer drag gesture is running. */
    freezeTree() {
        this.inspectionTree?.freeze();
    }

    /** Re-enables the shared tree after a temporary drag freeze. */
    unfreezeTree() {
        this.inspectionTree?.unfreeze();
    }
}
