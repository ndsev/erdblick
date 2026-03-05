import {CompositeLayer} from "@deck.gl/core";
import {IconLayer, IconLayerProps} from "@deck.gl/layers";
import Supercluster from "supercluster";
import type {PickingInfo, UpdateParameters} from "@deck.gl/core";
import type {ClusterFeature, ClusterProperties, PointFeature} from "supercluster";

export interface SearchResultClusterPoint {
    coordinates: [number, number];
    mapId: string;
    layerId: string;
    featureId: string;
    featureKey: string;
}

export interface SearchResultClusterLayerProps extends IconLayerProps<SearchResultClusterPoint> {
    clusterMaxZoom?: number;
}

export type SearchResultClusterLayerPickingInfo = PickingInfo<
    SearchResultClusterPoint | (SearchResultClusterPoint & ClusterProperties),
    {objects?: SearchResultClusterPoint[]}
>;

type SearchClusterFeature = PointFeature<SearchResultClusterPoint> | ClusterFeature<ClusterProperties>;

function iconSizeScale(size: number): number {
    return Math.min(100, size) / 100 + 1;
}

function isClusterFeature(feature: SearchClusterFeature): feature is ClusterFeature<ClusterProperties> {
    return !!(feature.properties as ClusterProperties).cluster;
}

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

    override shouldUpdateState({changeFlags}: UpdateParameters<this>): boolean {
        return changeFlags.somethingChanged;
    }

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

    override renderLayers(): IconLayer<SearchClusterFeature> {
        const data = this.state.data ?? [];
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
            this.getSubLayerProps({
                id: "icon"
            })
        );
    }
}
