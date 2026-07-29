import type {LayerInfoItem} from "./map.tree.model";

/**
 * Immutable catalog identity for one mapget feature layer.
 *
 * `sourceId` is provenance and an optional request assertion. It is not part
 * of MapTileKey identity. `stringPoolId` is the datasource's catalog namespace;
 * an exact delivered model can name a different, composed namespace and must
 * be queried directly before transferring that model to another parser.
 */
export class MapgetLayer {
    readonly key: string;

    constructor(
        readonly sourceId: string,
        readonly stringPoolId: string,
        readonly mapId: string,
        readonly layerId: string,
        readonly info: Readonly<LayerInfoItem>
    ) {
        this.key = `${mapId}/${layerId}`;
        Object.freeze(this);
    }
}
