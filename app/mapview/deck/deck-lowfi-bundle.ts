export interface DeckLowFiRawBundle {
    lod: number;
    pointPositions: Uint8Array;
    pointColors: Uint8Array;
    pointRadii: Uint8Array;
    pointFeatureIds: Uint8Array;
    positions: Uint8Array;
    startIndices: Uint8Array;
    colors: Uint8Array;
    widths: Uint8Array;
    featureIds: Uint8Array;
    dashArrays: Uint8Array;
    dashOffsets: Uint8Array;
    arrowPositions: Uint8Array;
    arrowStartIndices: Uint8Array;
    arrowColors: Uint8Array;
    arrowWidths: Uint8Array;
    arrowFeatureIds: Uint8Array;
}

function availableLowFiLods(readRawBytes: (accessorName: string) => Uint8Array): number[] {
    const raw = readRawBytes("availableLowFiLodsRaw");
    if (!raw.length) {
        return [];
    }
    return [...new Set(Array.from(raw))]
        .filter((lod) => Number.isInteger(lod) && lod >= 0 && lod <= 7)
        .sort((lhs, rhs) => lhs - rhs);
}

export function collectLowFiRawBundles(
    deckVisu: any,
    readRawBytes: (accessorName: string) => Uint8Array
): DeckLowFiRawBundle[] {
    if (typeof deckVisu?.setLowFiOutputLod !== "function") {
        return [];
    }
    const lods = availableLowFiLods(readRawBytes);
    if (!lods.length) {
        return [];
    }

    const bundles: DeckLowFiRawBundle[] = [];
    try {
        for (const lod of lods) {
            deckVisu.setLowFiOutputLod(lod);
            bundles.push({
                lod,
                pointPositions: readRawBytes("pointPositionsRaw"),
                pointColors: readRawBytes("pointColorsRaw"),
                pointRadii: readRawBytes("pointRadiiRaw"),
                pointFeatureIds: readRawBytes("pointFeatureIdsRaw"),
                positions: readRawBytes("pathPositionsRaw"),
                startIndices: readRawBytes("pathStartIndicesRaw"),
                colors: readRawBytes("pathColorsRaw"),
                widths: readRawBytes("pathWidthsRaw"),
                featureIds: readRawBytes("pathFeatureIdsRaw"),
                dashArrays: readRawBytes("pathDashArrayRaw"),
                dashOffsets: readRawBytes("pathDashOffsetsRaw"),
                arrowPositions: readRawBytes("arrowPositionsRaw"),
                arrowStartIndices: readRawBytes("arrowStartIndicesRaw"),
                arrowColors: readRawBytes("arrowColorsRaw"),
                arrowWidths: readRawBytes("arrowWidthsRaw"),
                arrowFeatureIds: readRawBytes("arrowFeatureIdsRaw")
            });
        }
    } finally {
        deckVisu.setLowFiOutputLod(-1);
    }
    return bundles;
}
