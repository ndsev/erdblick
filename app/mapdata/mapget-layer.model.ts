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

    /** Addressing mode advertised by mapget; omitted means legacy tile mode. */
    get partitionKind(): "tile" | "object" {
        return this.info.partitionKind === "object" ? "object" : "tile";
    }

    /** Fixed spatial level used only to discover object associations. */
    get tileAssociationLevel(): number | null {
        const level = Number(this.info.tileAssociationLevel);
        return this.partitionKind === "object" &&
            Number.isInteger(level) && level >= 0 && level <= 15
            ? level
            : null;
    }
}
