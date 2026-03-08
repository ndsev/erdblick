import {Component, output, input, effect, ViewChild} from "@angular/core";
import {SourceDataAddressFormat} from "build/libs/core/erdblick-core";
import {InspectionPanelModel} from "../shared/appstate.service";
import {TreeTableNode} from "primeng/api";
import {TileSourceDataLayer} from "../../build/libs/core/erdblick-core";
import {FeatureWrapper} from "../mapdata/features.model";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import {
    MapTileRequestStatus,
    MapTileStreamClient,
} from "../mapdata/tilestream";
import {MapDataService} from "../mapdata/map.service";
import {Column, InspectionTreeComponent} from "./inspection.tree.component";

@Component({
    selector: 'sourcedata-panel',
    template: `
        @if (loading) {
            <div class="spinner">
                <p-progressSpinner ariaLabel="loading"/>
            </div>
        } @else {
            <inspection-tree [treeData]="treeData" [columns]="columns" [panelId]="panel().id"
                             [filterText]="filterText()" (filterTextChange)="filterTextChange.emit($event)"
                             [showFilter]="showFilter()"
                             [firstHighlightedItemIndex]="firstHighlightedItemIndex">
            </inspection-tree>
        }
    `,
    styles: [``],
    standalone: false
})
export class SourceDataPanelComponent {

    panel = input.required<InspectionPanelModel<FeatureWrapper>>();
    filterText = input<string | undefined>();
    filterTextChange = output<string>();
    showFilter = input<boolean>(true);
    error = output<string>({ alias: 'errorOccurred' });

    loading: boolean = true;

    treeData: TreeTableNode[] = [];
    columns: Column[] = [
        { key: "key",     header: "Key",     width: '0*',    transform: (colKey, rowData) => rowData[colKey] },
        { key: "value",   header: "Value",   width: '0*',    transform: (colKey, rowData) => rowData[colKey] },
        { key: "address", header: "Address", width: '100px', transform: this.addressFormatter.bind(this) },
        { key: "type",    header: "Type",    width: 'auto',  transform: this.schemaTypeURLFormatter.bind(this) }
    ]

    addressFormat: SourceDataAddressFormat = coreLib.SourceDataAddressFormat.BIT_RANGE;
    firstHighlightedItemIndex: number = 0;

    @ViewChild(InspectionTreeComponent) inspectionTree?: InspectionTreeComponent;

    constructor(private mapService: MapDataService) {
        effect(() => {
            if (!this.panel().sourceData) {
                return;
            }

            this.loadSourceDataLayer(this.panel().sourceData!.mapTileKey)
                .then(layer => {
                    const root = layer.toObject();
                    this.addressFormat = layer.addressFormat();

                    layer.delete();

                    if (root) {
                        this.treeData = root.children ? root.children : [root];
                        this.selectItemWithAddress(this.panel().sourceData!.address);
                    } else {
                        this.treeData = [];
                        this.setError('Empty layer.');
                    }
                })
                .catch(error => {
                    this.setError(`${error}`);
                })
                .finally(() => {
                    this.loading = false;
                });
        });
    }

    async loadSourceDataLayer(mapTileKey: string) : Promise<TileSourceDataLayer> {
        const [mapId, layerId, tileId] = coreLib.parseMapTileKey(mapTileKey);
        const requestBody = {
            requests: [{
                mapId: mapId,
                layerId: layerId,
                tileIds: [Number(tileId)]
            }]
        };

        let layer: TileSourceDataLayer | null = null;
        let sourceDataParseError: Error | null = null;
        const socket = new MapTileStreamClient("/tiles");
        const dataSourceInfoJson = this.mapService.getDataSourceInfoJson();
        if (dataSourceInfoJson) {
            socket.setDataSourceInfoJson(dataSourceInfoJson);
        }

        socket.withSourceDataCallback((payload) => {
            try {
                const parsedLayer = uint8ArrayToWasm((wasmBlob) => {
                    return socket.parser.readTileSourceDataLayer(wasmBlob);
                }, payload);
                if (parsedLayer) {
                    (layer as any)?.delete();
                    layer = parsedLayer;
                }
            } catch (err) {
                sourceDataParseError = err instanceof Error ? err : new Error(`${err}`);
            }
        });

        let status;
        try {
            socket.sendRequest(requestBody);
            status = await socket.waitForCompletion();

            const waitUntil = Date.now() + 5000;
            while (!layer && !sourceDataParseError && Date.now() < waitUntil) {
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        } catch (err) {
            (layer as any)?.delete();
            throw err instanceof Error ? err : new Error(`${err}`);
        } finally {
            socket.destroy();
        }

        if (sourceDataParseError) {
            (layer as any)?.delete();
            throw sourceDataParseError;
        }

        const statusMessage = status.message || "";
        const failures = (status.requests || []).filter(req => req.status !== MapTileRequestStatus.Success);
        if (failures.length) {
            const summary = failures
                .map(req => `${req.mapId}/${req.layerId}: ${req.statusText}`)
                .join(", ");
            (layer as any)?.delete();
            throw new Error(`Tile request failed: ${summary}`);
        }

        if (!layer) {
            throw new Error(statusMessage || "Unknown error while loading layer (no SourceData payload received).");
        }

        const error = (layer as unknown as { getError: () => string }).getError();
        if (error) {
            (layer as any)?.delete();
            throw new Error(`Error while loading layer: ${error}`);
        }

        return layer;
    }

    /**
     * Set an error message that gets displayed.
     * Unsets the tree to an empty array.
     *
     * @param message Error message
     */
    setError(message: string) {
        this.loading = false;
        this.treeData = [];
        this.error.emit(message);
    }

    /**
     * Returns an HTML <a> tag, with the URL pointing to the nds.live documentation
     * for the given zserio type schema.
     *
     * @param schema Zserio schema string
     * @return string HTML
     */
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

    selectItemWithAddress(address?: bigint) {
        let addressInRange: (address: any) => boolean | undefined;
        if (address !== undefined) {
            if (this.addressFormat == coreLib.SourceDataAddressFormat.BIT_RANGE) {
                const searchAddress = {
                    offset: address >> BigInt(32) & BigInt(0xFFFFFFFF),
                    size: address & BigInt(0xFFFFFFFF),
                }

                const addressLow = typeof searchAddress === 'object' ? searchAddress['offset'] : searchAddress;
                const addressHigh = addressLow + (typeof searchAddress === 'object' ? searchAddress['size'] : searchAddress);

                addressInRange = (address: any) => {
                    return address.offset >= addressLow &&
                        address.offset + address.size <= addressHigh &&
                        (address.size != 0 || addressLow == addressHigh);
                }
            } else {
                const searchAddress = address;
                addressInRange = (address: any) => {
                    return address == searchAddress;
                }
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

            if (node.data.address && addressInRange && addressInRange(node.data.address)) {
                highlight = true;

                if (!firstHighlightedItemIndex) {
                    firstHighlightedItemIndex = virtualRowIndex;
                }

                node.data.styleClass = "highlight";
                parents.forEach((parent: TreeTableNode) =>{
                    parent.expanded = true;
                });
            }

            if (address === undefined && node.children && node.children.length < 5) {
                node.expanded = true;
                for (const child of node.children) {
                    if (child.children && child.children.length < 5) {
                        child.expanded = true;
                    }
                }
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

        if (address === undefined) {
            for (const item of this.treeData) {
                if (item.children) {
                    item.expanded = true;
                    for (const child of item.children) {
                        if (child.children && child.children.length < 5) {
                            child.expanded = true;
                        }
                    }
                }
            }
        }

        this.firstHighlightedItemIndex = firstHighlightedItemIndex ?? 0;
    }

    freezeTree() {
        this.inspectionTree?.freeze();
    }

    unfreezeTree() {
        this.inspectionTree?.unfreeze();
    }
}
