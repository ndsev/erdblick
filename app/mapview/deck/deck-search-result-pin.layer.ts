import {IconLayer, IconLayerProps} from "@deck.gl/layers";
import type {SearchResultPinMarker} from "../../search/feature.search.service";

/** Public props for the low-fidelity search-result pin layer. */
export interface SearchResultPinLayerProps extends IconLayerProps<SearchResultPinMarker> {
    data: SearchResultPinMarker[];
}

const DECK_NO_DEPTH_TEST_PARAMETERS = {
    depthTest: false
} as any;

/** Maps a marker count to the modest size ramp used by the atlas sprites. */
function searchResultPinSizeScale(size: number): number {
    const clampedSize = Math.max(0, Math.min(100, size));
    return clampedSize / 100 + 1;
}

/** Maps a marker count to one of the icon names provided by the search-marker atlas. */
function searchResultPinIconName(size: number): string {
    if (size <= 0) {
        return "";
    }
    if (size < 10) {
        return `marker-${size}`;
    }
    if (size < 100) {
        return `marker-${Math.floor(size / 10)}0`;
    }
    return "marker-100";
}

/** Creates one plain deck IconLayer from already aggregated search-result pin markers. */
export function createSearchResultPinLayer(props: SearchResultPinLayerProps): IconLayer<SearchResultPinMarker> {
    return new IconLayer<SearchResultPinMarker>({
        ...props,
        parameters: {
            ...(props.parameters ?? {}),
            ...DECK_NO_DEPTH_TEST_PARAMETERS
        },
        getPosition: marker => marker.coordinates,
        getIcon: marker => searchResultPinIconName(marker.count),
        getSize: marker => searchResultPinSizeScale(marker.count),
        sizeScale: props.sizeScale ?? 40,
        sizeUnits: "pixels",
        alphaCutoff: 0.05
    });
}
