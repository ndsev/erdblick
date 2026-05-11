import {CompositeLayer} from "@deck.gl/core";
import {IconLayer, IconLayerProps} from "@deck.gl/layers";
import Supercluster from "supercluster";
import type {PickingInfo, UpdateParameters} from "@deck.gl/core";
import type {ClusterFeature, ClusterProperties, PointFeature} from "supercluster";

/** Search-result datum consumed by the cluster layer before supercluster indexing. */
export interface SearchResultClusterPoint {
    coordinates: [number, number];
    mapId: string;
    layerId: string;
    featureId: string;
    featureKey: string;
}

/** Public props for the search-result cluster layer, extending deck's icon-layer props. */
export interface SearchResultClusterLayerProps extends IconLayerProps<SearchResultClusterPoint> {
    clusterMaxZoom?: number;
}

/** Picking info emitted by the cluster layer for single markers and expanded clusters. */
export type SearchResultClusterLayerPickingInfo = PickingInfo<
    SearchResultClusterPoint | (SearchResultClusterPoint & ClusterProperties),
    {objects?: SearchResultClusterPoint[]}
>;

type SearchClusterFeature = PointFeature<SearchResultClusterPoint> | ClusterFeature<ClusterProperties>;

const DECK_NO_DEPTH_TEST_PARAMETERS = {
    depthTest: false
} as any;

function iconSizeScale(size: number): number {
    return Math.min(100, size) / 100 + 1;
}

/** Narrows a supercluster feature to an aggregated cluster entry. */
function isClusterFeature(feature: SearchClusterFeature): feature is ClusterFeature<ClusterProperties> {
    return !!(feature.properties as ClusterProperties).cluster;
}

/** Maps a cluster size to one of the atlas icon names expected by the marker sheet. */
function getIconName(size: number): string {
    if (size === 0) {
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

/**
 * Adapted from deck.gl's icon-cluster-layer example.
 * Clusters arbitrary point data with supercluster and renders marker icons.
 */
export class SearchResultClusterLayer extends CompositeLayer<SearchResultClusterLayerProps> {
    static override layerName = "SearchResultClusterLayer";

    override state!: {
        data: SearchClusterFeature[];
        index: Supercluster<SearchResultClusterPoint, ClusterProperties>;
        z: number;
    };

    /** Any data, size, or viewport zoom change is enough to require reclustering or redraw. */
    override shouldUpdateState({changeFlags}: UpdateParameters<this>): boolean {
        return changeFlags.somethingChanged;
    }

    /** Rebuilds the supercluster index when needed and refreshes the visible cluster set for the current zoom. */
    override updateState({props, oldProps, changeFlags}: UpdateParameters<this>): void {
        const rebuildIndex = changeFlags.dataChanged || props.sizeScale !== oldProps.sizeScale;
        if (rebuildIndex) {
            const index = new Supercluster<SearchResultClusterPoint, ClusterProperties>({
                maxZoom: props.clusterMaxZoom ?? 16,
                radius: (props.sizeScale ?? 40) * Math.sqrt(2)
            });
            const mappedData = ((props.data ?? []) as SearchResultClusterPoint[]).map(point => ({
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: (props.getPosition ? (props.getPosition as (d: SearchResultClusterPoint) => [number, number])(point) : point.coordinates)
                },
                properties: point
            })) as unknown as PointFeature<SearchResultClusterPoint>[];
            index.load(mappedData);
            this.setState({index});
        }

        const zoomLevel = Math.floor(this.context.viewport.zoom);
        if (rebuildIndex || zoomLevel !== this.state.z) {
            this.setState({
                data: this.state.index.getClusters([-180, -85, 180, 85], zoomLevel) as SearchClusterFeature[],
                z: zoomLevel
            });
        }
    }

    /** Expands cluster picks into a small leaf sample so callers can inspect grouped search results. */
    override getPickingInfo({
        info,
        mode
    }: {
        info: PickingInfo<SearchClusterFeature>;
        mode: string;
    }): SearchResultClusterLayerPickingInfo {
        const pickedObject = info.object?.properties as (SearchResultClusterPoint & ClusterProperties) | undefined;
        if (pickedObject) {
            let objects: SearchResultClusterPoint[] | undefined;
            if (pickedObject.cluster && mode !== "hover") {
                objects = this.state.index.getLeaves(pickedObject.cluster_id, 25)
                    .map((feature: PointFeature<SearchResultClusterPoint>) => feature.properties);
            }
            return {...info, object: pickedObject, objects};
        }
        return {...info, object: undefined};
    }

    /** Renders one icon sublayer with depth testing disabled so markers stay visible above map geometry. */
    override renderLayers(): IconLayer<SearchClusterFeature> {
        const data = this.state.data ?? [];
        const subLayerProps = this.getSubLayerProps({
            id: "icon",
            parameters: {
                ...(this.props.parameters ?? {}),
                ...DECK_NO_DEPTH_TEST_PARAMETERS
            }
        });
        return new IconLayer<SearchClusterFeature>(
            {
                data,
                pickable: this.props.pickable ?? false,
                getPosition: feature => feature.geometry.coordinates as [number, number],
                iconAtlas: this.props.iconAtlas,
                iconMapping: this.props.iconMapping,
                getIcon: feature => {
                    const count = isClusterFeature(feature)
                        ? feature.properties.point_count
                        : 1;
                    return getIconName(count);
                },
                getSize: feature => {
                    const count = isClusterFeature(feature)
                        ? feature.properties.point_count
                        : 1;
                    return iconSizeScale(count);
                },
                sizeScale: this.props.sizeScale ?? 40,
                sizeUnits: "pixels",
                alphaCutoff: 0.05
            },
            subLayerProps
        );
    }
}
