import {IconLayer, IconLayerProps, TextLayer, TextLayerProps} from "@deck.gl/layers";
import type {Parameters as LumaParameters} from "@luma.gl/core";
import type {SearchResultDensityMarker} from "../../search/search-result-density.model";

/** Public props for the low-fidelity search-result density layer. */
export interface SearchResultDensityLayerProps extends IconLayerProps<SearchResultDensityMarker> {
    data: SearchResultDensityMarker[];
    dotColor: [number, number, number, number];
    countDomain?: SearchResultDensityCountDomain;
}

/** Public props for low-fidelity search-result bucket labels. */
export interface SearchResultDensityLabelLayerProps extends TextLayerProps<SearchResultDensityMarker> {
    data: SearchResultDensityMarker[];
}

export interface SearchResultDensityLayoutEntry {
    marker: SearchResultDensityMarker;
    sortKey: string;
    countDomain?: SearchResultDensityCountDomain;
}

export interface SearchResultDensityCountDomain {
    min: number;
    max: number;
}

export const SEARCH_RESULT_DENSITY_DEFAULT_SIZE_SCALE = 16;

const SEARCH_RESULT_DENSITY_GRID_GAP_PX = 4;
const SEARCH_RESULT_DENSITY_MIN_SIZE_FACTOR = 0.85;
const SEARCH_RESULT_DENSITY_MAX_SIZE_FACTOR = 2.45;
const SEARCH_RESULT_DENSITY_MAX_COUNT_FOR_SIZE = 10000;
const SEARCH_RESULT_DENSITY_DEFAULT_COUNT_DOMAIN: SearchResultDensityCountDomain = {min: 1, max: 1};
const SEARCH_RESULT_DOT_ICON_ATLAS =
    "data:image/svg+xml;charset=utf-8,"
    + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
<circle cx="32" cy="32" r="30" fill="white"/>
</svg>`);
const SEARCH_RESULT_DOT_ICON_MAPPING = {
    dot: {x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true}
};

const DECK_NO_DEPTH_TEST_PARAMETERS: LumaParameters = {
    depthWriteEnabled: false,
    depthCompare: "always"
};

/** Returns the min/max aggregate counts currently visible in one rendered search-dot layer. */
export function searchResultDensityCountDomain(markers: readonly SearchResultDensityMarker[]): SearchResultDensityCountDomain {
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (const marker of markers) {
        const count = Math.max(1, Math.floor(marker.count));
        if (!Number.isFinite(count)) {
            continue;
        }
        min = Math.min(min, count);
        max = Math.max(max, count);
    }
    return max > 0 ? {min, max} : SEARCH_RESULT_DENSITY_DEFAULT_COUNT_DOMAIN;
}

/** Maps an aggregate count into the visible layer's observed min/max density range. */
function searchResultDensitySizeScale(
    size: number,
    countDomain: SearchResultDensityCountDomain = SEARCH_RESULT_DENSITY_DEFAULT_COUNT_DOMAIN
): number {
    const count = Math.max(1, Math.min(SEARCH_RESULT_DENSITY_MAX_COUNT_FOR_SIZE, Math.floor(size)));
    const minCount = Math.max(1, Math.min(SEARCH_RESULT_DENSITY_MAX_COUNT_FOR_SIZE, Math.floor(countDomain.min)));
    const maxCount = Math.max(minCount, Math.min(SEARCH_RESULT_DENSITY_MAX_COUNT_FOR_SIZE, Math.floor(countDomain.max)));
    const normalized = maxCount > minCount
        ? (Math.log10(count) - Math.log10(minCount)) / Math.max(1e-6, Math.log10(maxCount) - Math.log10(minCount))
        : Math.log10(count) / Math.log10(SEARCH_RESULT_DENSITY_MAX_COUNT_FOR_SIZE);
    const clamped = Math.max(0, Math.min(1, normalized));
    return SEARCH_RESULT_DENSITY_MIN_SIZE_FACTOR
        + clamped * (SEARCH_RESULT_DENSITY_MAX_SIZE_FACTOR - SEARCH_RESULT_DENSITY_MIN_SIZE_FACTOR);
}

/** Returns the compact bucket label shown inside a low-fidelity search-result dot. */
export function searchResultDensityBucketLabel(size: number): string {
    const count = Number.isFinite(size) ? Math.floor(size) : 0;
    if (count <= 0) {
        return "";
    }
    if (count <= 4) {
        return `${count}`;
    }
    if (count < 1000) {
        const thresholds = [500, 200, 100, 50, 20, 10, 5];
        const threshold = thresholds.find(candidate => count >= candidate) ?? 5;
        return `${threshold}+`;
    }
    return `${Math.min(10, Math.floor(count / 1000))}k+`;
}

/** Returns the effective screen-space icon diameter used by Deck for one count marker. */
export function searchResultDensityRenderSizePixels(
    size: number,
    sizeScale = SEARCH_RESULT_DENSITY_DEFAULT_SIZE_SCALE,
    countDomain: SearchResultDensityCountDomain = SEARCH_RESULT_DENSITY_DEFAULT_COUNT_DOMAIN
): number {
    return searchResultDensitySizeScale(size, countDomain) * sizeScale;
}

/** Assigns size-aware, stable screen offsets for markers sharing the same aggregate mapget tile. */
export function layoutSearchResultDensityMarkers(
    entries: SearchResultDensityLayoutEntry[],
    sizeScale = SEARCH_RESULT_DENSITY_DEFAULT_SIZE_SCALE
): void {
    const entriesByTileId = new Map<string, SearchResultDensityLayoutEntry[]>();
    for (const entry of entries) {
        const tileKey = entry.marker.tileId.toString();
        const tileEntries = entriesByTileId.get(tileKey) ?? [];
        tileEntries.push(entry);
        entriesByTileId.set(tileKey, tileEntries);
    }

    for (const tileEntries of entriesByTileId.values()) {
        if (tileEntries.length === 1) {
            tileEntries[0].marker.pixelOffset = [0, 0];
            continue;
        }

        tileEntries.sort((lhs, rhs) => lhs.sortKey.localeCompare(rhs.sortKey));
        const maxIconSize = Math.max(
            ...tileEntries.map(entry => searchResultDensityRenderSizePixels(
                entry.marker.count,
                sizeScale,
                entry.countDomain
            ))
        );
        const cellSize = Math.ceil(maxIconSize + SEARCH_RESULT_DENSITY_GRID_GAP_PX);
        const columns = Math.ceil(Math.sqrt(tileEntries.length));
        const rows = Math.ceil(tileEntries.length / columns);

        for (let index = 0; index < tileEntries.length; index++) {
            const column = index % columns;
            const row = Math.floor(index / columns);
            tileEntries[index].marker.pixelOffset = [
                (column - (columns - 1) / 2) * cellSize,
                (row - (rows - 1) / 2) * cellSize
            ];
        }
    }
}

/** Creates one plain deck IconLayer from already aggregated search-result dot markers. */
export function createSearchResultDensityLayer(props: SearchResultDensityLayerProps): IconLayer<SearchResultDensityMarker> {
    const countDomain = props.countDomain ?? searchResultDensityCountDomain(props.data);
    return new IconLayer<SearchResultDensityMarker>({
        ...props,
        parameters: {
            ...(props.parameters ?? {}),
            ...DECK_NO_DEPTH_TEST_PARAMETERS
        },
        iconAtlas: SEARCH_RESULT_DOT_ICON_ATLAS,
        iconMapping: SEARCH_RESULT_DOT_ICON_MAPPING,
        getPosition: marker => marker.coordinates,
        getPixelOffset: marker => marker.pixelOffset ?? [0, 0],
        getIcon: () => "dot",
        getSize: marker => searchResultDensitySizeScale(marker.count, countDomain),
        getColor: () => props.dotColor,
        sizeScale: props.sizeScale ?? SEARCH_RESULT_DENSITY_DEFAULT_SIZE_SCALE,
        sizeUnits: "pixels",
        alphaCutoff: 0.05
    });
}

/** Creates text labels for the compact count buckets shown in aggregate search-result dots. */
export function createSearchResultDensityLabelLayer(
    props: SearchResultDensityLabelLayerProps
): TextLayer<SearchResultDensityMarker> {
    return new TextLayer<SearchResultDensityMarker>({
        ...props,
        parameters: {
            ...(props.parameters ?? {}),
            ...DECK_NO_DEPTH_TEST_PARAMETERS
        },
        getPosition: marker => marker.coordinates,
        getPixelOffset: marker => marker.pixelOffset ?? [0, 0],
        getText: marker => marker.showBucketLabel === false ? "" : searchResultDensityBucketLabel(marker.count),
        getSize: 11,
        sizeUnits: "pixels",
        getTextAnchor: "middle",
        getAlignmentBaseline: "center",
        getColor: [255, 255, 255, 245],
        fontWeight: "700",
        billboard: true
    });
}
