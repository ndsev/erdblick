import {Layer, LayerContext, LayerExtension} from "@deck.gl/core";

const MAX_CLIP_SPACE_BIAS = 0.00025;
const TARGET_DEPTH_STEPS = 1024;
const MAX_TIE_BUCKETS = 32;
const UNSELECTABLE = 0xffffffff;

const zIndexShaderModule = {
    name: "erdblickZIndex",
    inject: {
        "vs:#decl": `
in float zIndexOffsets;
`,
        "vs:DECKGL_FILTER_GL_POSITION": `
  // Subtracting offset*w applies a perspective-independent NDC depth bias.
  position.z -= zIndexOffsets * position.w;
`
    }
};

/**
 * Separates coplanar objects according to an ordinal style z-index.
 *
 * The attribute already contains a tiny clip-space bias. Keeping the shader
 * transform linear lets the CPU rank sparse or very large authored values
 * without turning values such as a uint16 drawing order into physical height.
 */
export class DeckZIndexExtension extends LayerExtension {
    static override defaultProps = {
        getZIndexOffset: {type: "accessor", value: 0}
    };
    static override extensionName = "DeckZIndexExtension";

    /** Installs the clip-space position hook on any WebGL vector layer. */
    override getShaders(): unknown {
        return {modules: [zIndexShaderModule]};
    }

    /** Registers one dynamic attribute that follows each layer's tessellation. */
    override initializeState(this: Layer, _context: LayerContext): void {
        this.getAttributeManager()?.add({
            zIndexOffsets: {
                size: 1,
                stepMode: "dynamic",
                accessor: "getZIndexOffset",
                defaultValue: 0
            }
        });
    }
}

/**
 * Converts sparse authored orders into bounded clip-space offsets.
 *
 * Primary values retain strict numeric ordering. Equal values share a small
 * number of first-emission-ordered tie buckets so overlapping same-order
 * features do not all fight for the exact same depth value. Returning
 * `undefined` keeps layers whose styles do not use z-index entirely on Deck's
 * stock path.
 */
export function buildZIndexOffsets(
    zIndices: ArrayLike<number>,
    tieBreakers: ArrayLike<number>
): Float32Array | undefined {
    const count = zIndices.length;
    let hasAuthoredValue = false;
    const values = new Float64Array(count);
    const unique = new Set<number>();
    for (let index = 0; index < count; ++index) {
        const value = Number(zIndices[index]);
        if (Number.isFinite(value)) {
            values[index] = value;
            unique.add(value);
            hasAuthoredValue = true;
        } else {
            values[index] = 0;
            unique.add(0);
        }
    }
    if (!hasAuthoredValue || count === 0) {
        return undefined;
    }

    const orderedValues = [...unique].sort((left, right) => left - right);
    const primaryRanks = new Map<number, number>();
    orderedValues.forEach((value, index) => primaryRanks.set(value, index));
    const tieRanks = new Uint32Array(count);
    const tiesByValue = new Map<number, Map<number, number>>();
    for (let index = 0; index < count; ++index) {
        const tieValue = Number(tieBreakers[index]);
        const tieKey = Number.isFinite(tieValue) && tieValue !== UNSELECTABLE
            ? tieValue
            : index;
        const ties = tiesByValue.get(values[index]) ?? new Map<number, number>();
        let rank = ties.get(tieKey);
        if (rank === undefined) {
            rank = ties.size;
            ties.set(tieKey, rank);
        }
        tieRanks[index] = rank;
        tiesByValue.set(values[index], ties);
    }
    const tieBucketCount = Math.max(1, Math.min(
        MAX_TIE_BUCKETS,
        Math.floor(TARGET_DEPTH_STEPS / orderedValues.length)
    ));
    const rankCount = Math.max(1, orderedValues.length * tieBucketCount);
    const step = MAX_CLIP_SPACE_BIAS / rankCount;
    const result = new Float32Array(count);
    for (let index = 0; index < count; ++index) {
        const primary = primaryRanks.get(values[index]) ?? 0;
        const tieCount = tiesByValue.get(values[index])?.size ?? 1;
        const tie = tieBucketCount === 1 || tieCount === 1
            ? 0
            : Math.floor(
                tieRanks[index] * (tieBucketCount - 1) / (tieCount - 1)
            );
        result[index] = (primary * tieBucketCount + tie) * step;
    }
    return result;
}
