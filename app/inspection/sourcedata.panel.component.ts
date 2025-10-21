import {Component, OnInit, output, input} from "@angular/core";
import {SourceDataAddressFormat} from "build/libs/core/erdblick-core";
import {InspectionPanelModel} from "../shared/appstate.service";
import {TreeTableNode} from "primeng/api";
import {TileSourceDataLayer} from "../../build/libs/core/erdblick-core";
import {FeatureWrapper} from "../mapdata/features.model";
import {coreLib, uint8ArrayToWasm} from "../integrations/wasm";
import {Fetch} from "../mapdata/fetch";
import {Column} from "./inspection.tree.component";

@Component({
    selector: 'sourcedata-panel',
    template: `
        @if (loading) {
            <div class="spinner">
                <p-progressSpinner ariaLabel="loading"/>
            </div>
        } @else {
            <inspection-tree [treeData]="treeData" [filterFields]="filterFields" [columns]="columns" [firstHighlightedItemIndex]="firstHighlightedItemIndex" [panelId]="panel().id"></inspection-tree>
        }
    `,
    styles: [``],
    standalone: false
})
export class SourceDataPanelComponent implements OnInit {

    panel = input.required<InspectionPanelModel<FeatureWrapper>>();
    error = output<string>();

    loading: boolean = true;

    treeData: TreeTableNode[] = [];
    filterFields = [
        "key",
        "value"
    ];
    columns: Column[] = [
        { key: "key",     header: "Key",     width: '0*',    transform: (v: any) => v },
        { key: "value",   header: "Value",   width: '0*',    transform: (v: any) => v },
        { key: "address", header: "Address", width: '100px', transform: this.addressFormatter.bind(this) },
        { key: "type",    header: "Type",    width: 'auto',  transform: this.schemaTypeURLFormatter.bind(this) },
    ]

    addressFormat: SourceDataAddressFormat = coreLib.SourceDataAddressFormat.BIT_RANGE;
    firstHighlightedItemIndex: number = 0;

    ngOnInit(): void {
        if (!this.panel().selectedSourceData) {
            return;
        }

        this.loadSourceDataLayer(this.panel().selectedSourceData!.mapTileKey)
            .then(layer => {
                const root = layer.toObject();
                this.addressFormat = layer.addressFormat();

                layer.delete();

                if (root) {
                    this.treeData = root.children ? root.children : [root];
                    this.selectItemWithAddress(this.panel().selectedSourceData!.address);
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
    }

    async loadSourceDataLayer(mapTileKey: string) : Promise<TileSourceDataLayer> {
        let parser : any = null;
        try {
            parser = new coreLib.TileLayerParser();
            const [mapId, layerId, tileId] = coreLib.parseTileFeatureLayerKey(mapTileKey)
            const newRequestBody = JSON.stringify({
                requests: [{
                    mapId: mapId,
                    layerId: layerId,
                    tileIds: [tileId]
                }]
            });

            let layer: TileSourceDataLayer | undefined;
            let fetch = new Fetch("tiles")
                .withChunkProcessing()
                .withMethod("POST")
                .withBody(newRequestBody)
                .withBufferCallback((message: any, messageType: any) => {
                    if (messageType === Fetch.CHUNK_TYPE_FIELDS) {
                        uint8ArrayToWasm((wasmBuffer: any) => {
                            parser!.readFieldDictUpdate(wasmBuffer);
                        }, message);
                    } else if (messageType === Fetch.CHUNK_TYPE_SOURCEDATA) {
                        const blob = message.slice(Fetch.CHUNK_HEADER_SIZE);
                        layer = uint8ArrayToWasm((wasmBlob: any) => {
                            return parser.readTileSourceDataLayer(wasmBlob);
                        }, blob);
                    } else {
                        throw new Error(`Unknown message type ${messageType}.`)
                    }
                });

            return fetch.go()
                .then(_ => {
                    if (!layer)
                        throw new Error(`Unknown error while loading layer.`);
                    const error = layer.getError();
                    if (error) {
                        layer.delete();
                        throw new Error(`Error while loading layer: ${error}`);
                    }
                    return layer;
                });
        } finally {
            if (parser) parser.delete();
        }
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

        console.error("Error while processing SourceData tree:", message);
    }

    /**
     * Returns an HTML <a> tag, with the URL pointing to the nds.live documentation
     * for the given zserio type schema.
     *
     * @param schema Zserio schema string
     * @return string HTML
     */
    schemaTypeURLFormatter(schema?: string) {
        if (!schema) {
            return schema;
        }

        const prefix = "https://developer.nds.live/schema/";

        const match = schema.match(/^nds\.(([^.]+\.)+)v(\d{4}_\d{2})((\.[^.]*)+)/);
        if (!match || match.length <= 4)
            return schema;

        // Sub-namespaces in front of the version get joined by "-". Names past the version get joined by "/"
        const url =
            match[1].replace(/^(.*)\.$/, "$1/").replaceAll(".", "-") +
            match[3].replaceAll("_", ".") +
            match[4].replaceAll(".", "/");
        return `<a href="${prefix + url}" target="_blank">${schema}</a>`;
    }

    addressFormatter(address?: any): string {
        if (typeof address === 'object') {
            return `${address.offset}:${address.size}`
        } else if (address) {
            return `${address}`
        } else {
            return '';
        }
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

                if (!firstHighlightedItemIndex)
                    firstHighlightedItemIndex = virtualRowIndex;

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
                node.children.forEach((item: TreeTableNode, index) => { select(item, [...parents, node], highlight, 1 + virtualRowIndex + index) })
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
}
