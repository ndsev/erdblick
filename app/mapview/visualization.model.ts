import {FeatureTile} from "../mapdata/features.model";
import {TileLoadState} from "../mapdata/map-tile-stream-client";
import {coreLib} from "../integrations/wasm";
import {
    Color,
    ColorGeometryInstanceAttribute,
    GeometryInstance,
    Material,
    MaterialAppearance,
    PerInstanceColorAppearance,
    Primitive,
    PrimitiveCollection,
    Rectangle,
    RectangleGeometry,
    RectangleOutlineGeometry,
    Viewer
} from "../integrations/cesium";
import {FeatureLayerStyle, HighlightMode, TileFeatureLayer} from "../../build/libs/core/erdblick-core";
import {MapViewLayerStyleRule, MergedPointVisualization, PointMergeService} from "./pointmerge.service";

export interface LocateResolution {
    tileId: string,
    typeId: string,
    featureId: Array<string|number>
}

export interface LocateResponse {
    responses: Array<Array<LocateResolution>>
}

interface StyleWithIsDeleted extends FeatureLayerStyle {
    isDeleted(): boolean;
}

enum TileOverlayKind {
    None = 0,
    LoadingQueued = 1,
    BackendFetching = 2,
    BackendConverting = 3,
    RenderingQueued = 4,
    Empty = 5,
    Error = 6,
}

const BASE_OUTLINE_COLOR = Color.DIMGRAY.withAlpha(0.5);
const TRANSPARENT_COLOR = Color.WHITE.withAlpha(0.0);
const LOADING_OUTLINE_COLOR = Color.ORANGE.withAlpha(0.9);
const STRIPE_EVEN_COLOR = Color.ORANGE.withAlpha(0.35);
const STRIPE_ODD_COLOR = Color.ORANGE.withAlpha(0.1);
const RENDERING_FILL_COLOR = Color.ORANGE.withAlpha(0.2);
const EMPTY_FILL_COLOR = Color.GRAY.withAlpha(0.2);
const ERROR_FILL_COLOR = Color.RED.withAlpha(0.25);
const INSET_FRACTION = 0.06;
const STRIPE_REPEAT_FETCHING = 8.0;
const STRIPE_REPEAT_CONVERTING = 14.0;
const STRIPE_ST_ROTATION = Math.PI / 4;

/**
 * Ensure that low-detail representations are only rendered once
 * per map tile layer. Otherwise, they are rendered once per
 * (style sheet, tile layer) combination.
 */
class TileBoxVisualization {
    static tileBoxStatePerView: {
        visualizations: Map<bigint, TileBoxVisualization>,
        outlinePrimitive: Primitive | null,
        loadingOutlinePrimitive: Primitive | null,
        stripeFetchingPrimitive: Primitive | null,
        stripeConvertingPrimitive: Primitive | null,
        solidFillPrimitive: Primitive | null,
        loadingOutlineInstances: Map<bigint, GeometryInstance>,
        stripeFetchingInstances: Map<bigint, GeometryInstance>,
        stripeConvertingInstances: Map<bigint, GeometryInstance>,
        solidFillInstances: Map<bigint, GeometryInstance>,
        viewer: Viewer | null
    }[] = [];

    private static stripeMaterials: {fetching: Material | null, converting: Material | null} = {
        fetching: null,
        converting: null,
    };

    static getTileBoxState(viewIndex: number) {
        while (viewIndex >= this.tileBoxStatePerView.length) {
            this.tileBoxStatePerView.push({
                visualizations: new Map<bigint, TileBoxVisualization>(),
                outlinePrimitive: null,
                loadingOutlinePrimitive: null,
                stripeFetchingPrimitive: null,
                stripeConvertingPrimitive: null,
                solidFillPrimitive: null,
                loadingOutlineInstances: new Map<bigint, GeometryInstance>(),
                stripeFetchingInstances: new Map<bigint, GeometryInstance>(),
                stripeConvertingInstances: new Map<bigint, GeometryInstance>(),
                solidFillInstances: new Map<bigint, GeometryInstance>(),
                viewer: null,
            });
        }
        return this.tileBoxStatePerView[viewIndex];
    }

    static get(
        viewIndex: number,
        tile: FeatureTile,
        featureCount: number,
        viewer: Viewer,
        owner: TileVisualization,
        status?: TileLoadState,
        showBorder: boolean = false
    ): TileBoxVisualization {
        const state = this.getTileBoxState(viewIndex);
        state.viewer = viewer;
        if (!state.visualizations.has(tile.tileId)) {
            state.visualizations.set(
                tile.tileId, new TileBoxVisualization(viewIndex, tile));
            TileBoxVisualization.updatePrimitive(viewIndex, viewer);
        }
        const result = state.visualizations.get(tile.tileId)!;
        ++result.refCount;
        result.featureCount += featureCount;
        result.setBorder(owner, showBorder);
        result.setStatus(owner, status);
        return result;
    }

    static updatePrimitive(viewIndex: number, viewer?: Viewer) {
        const state = this.getTileBoxState(viewIndex);
        const activeViewer = viewer ?? state.viewer;
        if (!activeViewer) {
            return;
        }
        if (state.outlinePrimitive) {
            activeViewer.scene.primitives.remove(state.outlinePrimitive);
        }
        const instances = [...state.visualizations.values()].map(kv => kv.outlineInstance);
        if (!instances.length) {
            state.outlinePrimitive = null;
            return;
        }
        state.outlinePrimitive = activeViewer.scene.primitives.add(new Primitive({
            geometryInstances: instances,
            appearance: new PerInstanceColorAppearance({
                flat: true,
                translucent: true,
                renderState: {
                    depthTest: {
                        enabled: true
                    },
                    depthMask: false
                }
            }),
            asynchronous: false
        }));
    }

    static updateLoadingOutlinePrimitive(viewIndex: number) {
        const state = this.getTileBoxState(viewIndex);
        if (!state.viewer) {
            return;
        }
        if (state.loadingOutlinePrimitive) {
            state.viewer.scene.primitives.remove(state.loadingOutlinePrimitive);
        }
        const instances = [...state.loadingOutlineInstances.values()];
        if (!instances.length) {
            state.loadingOutlinePrimitive = null;
            return;
        }
        state.loadingOutlinePrimitive = state.viewer.scene.primitives.add(new Primitive({
            geometryInstances: instances,
            appearance: new PerInstanceColorAppearance({
                flat: true,
                translucent: true,
                renderState: {
                    depthTest: {
                        enabled: true
                    },
                    depthMask: false
                }
            }),
            asynchronous: false
        }));
    }

    static updateStripePrimitive(viewIndex: number, kind: "fetching" | "converting") {
        const state = this.getTileBoxState(viewIndex);
        if (!state.viewer) {
            return;
        }
        const instances = kind === "fetching"
            ? [...state.stripeFetchingInstances.values()]
            : [...state.stripeConvertingInstances.values()];
        const existing = kind === "fetching"
            ? state.stripeFetchingPrimitive
            : state.stripeConvertingPrimitive;
        if (existing) {
            state.viewer.scene.primitives.remove(existing);
        }
        if (!instances.length) {
            if (kind === "fetching") {
                state.stripeFetchingPrimitive = null;
            } else {
                state.stripeConvertingPrimitive = null;
            }
            return;
        }
        const appearance = new MaterialAppearance({
            material: TileBoxVisualization.getStripeMaterial(kind),
            flat: true,
            translucent: true,
            renderState: {
                depthTest: {
                    enabled: true
                },
                depthMask: false
            }
        });
        const primitive = state.viewer.scene.primitives.add(new Primitive({
            geometryInstances: instances,
            appearance: appearance,
            asynchronous: false
        }));
        if (kind === "fetching") {
            state.stripeFetchingPrimitive = primitive;
        } else {
            state.stripeConvertingPrimitive = primitive;
        }
    }

    static updateSolidFillPrimitive(viewIndex: number) {
        const state = this.getTileBoxState(viewIndex);
        if (!state.viewer) {
            return;
        }
        if (state.solidFillPrimitive) {
            state.viewer.scene.primitives.remove(state.solidFillPrimitive);
        }
        const instances = [...state.solidFillInstances.values()];
        if (!instances.length) {
            state.solidFillPrimitive = null;
            return;
        }
        state.solidFillPrimitive = state.viewer.scene.primitives.add(new Primitive({
            geometryInstances: instances,
            appearance: new PerInstanceColorAppearance({
                flat: true,
                translucent: true,
                renderState: {
                    depthTest: {
                        enabled: true
                    },
                    depthMask: false
                }
            }),
            asynchronous: false
        }));
    }

    private static getStripeMaterial(kind: "fetching" | "converting") {
        const existing = kind === "fetching"
            ? this.stripeMaterials.fetching
            : this.stripeMaterials.converting;
        if (existing) {
            return existing;
        }
        const repeat = kind === "fetching"
            ? STRIPE_REPEAT_FETCHING
            : STRIPE_REPEAT_CONVERTING;
        const material = Material.fromType(Material.StripeType, {
            evenColor: STRIPE_EVEN_COLOR,
            oddColor: STRIPE_ODD_COLOR,
            repeat: repeat,
            offset: 0.0,
            horizontal: true
        });
        if (kind === "fetching") {
            this.stripeMaterials.fetching = material;
        } else {
            this.stripeMaterials.converting = material;
        }
        return material;
    }

    refCount: number = 0;
    featureCount: number = 0;
    private readonly id: bigint;
    private readonly tile: FeatureTile;
    private readonly viewIndex: number;
    private outlineColorAttribute: ColorGeometryInstanceAttribute;
    private loadingOutlineColorAttribute: ColorGeometryInstanceAttribute;
    private solidInsetFillColorAttribute: ColorGeometryInstanceAttribute;
    private solidFullFillColorAttribute: ColorGeometryInstanceAttribute;
    private outlineInstance: GeometryInstance;
    private loadingOutlineInstance: GeometryInstance;
    private stripeFillInstance: GeometryInstance;
    private solidInsetFillInstance: GeometryInstance;
    private solidFullFillInstance: GeometryInstance;
    private statusByVisualization = new Map<TileVisualization, TileLoadState>();
    private borderByVisualization = new Map<TileVisualization, boolean>();
    private overlayKind: TileOverlayKind = TileOverlayKind.None;
    private borderVisible: boolean = false;

    constructor(viewIndex: number, tile: FeatureTile) {
        this.id = tile.tileId;
        this.tile = tile;
        this.viewIndex = viewIndex;

        const tileBox = coreLib.getTileBox(BigInt(tile.tileId));
        const rectangle = Rectangle.fromDegrees(...tileBox);
        const insetRectangle = TileBoxVisualization.insetRectangle(rectangle, INSET_FRACTION);

        const outlineGeometry = RectangleOutlineGeometry.createGeometry(new RectangleOutlineGeometry({
            rectangle: rectangle,
            height: 0.0
        }));
        const insetOutlineGeometry = RectangleOutlineGeometry.createGeometry(new RectangleOutlineGeometry({
            rectangle: insetRectangle,
            height: 0.0
        }));
        if (!outlineGeometry || !insetOutlineGeometry) {
            console.error("Failed to create RectangleOutlineGeometry!");
        }

        this.outlineColorAttribute = ColorGeometryInstanceAttribute.fromColor(TRANSPARENT_COLOR);
        this.loadingOutlineColorAttribute = ColorGeometryInstanceAttribute.fromColor(LOADING_OUTLINE_COLOR);
        this.solidInsetFillColorAttribute = ColorGeometryInstanceAttribute.fromColor(TRANSPARENT_COLOR);
        this.solidFullFillColorAttribute = ColorGeometryInstanceAttribute.fromColor(TRANSPARENT_COLOR);

        this.outlineInstance = new GeometryInstance({
            id: this.id,
            geometry: outlineGeometry!,
            attributes: {
                color: this.outlineColorAttribute
            }
        });

        this.loadingOutlineInstance = new GeometryInstance({
            id: this.id,
            geometry: insetOutlineGeometry!,
            attributes: {
                color: this.loadingOutlineColorAttribute
            }
        });

        const insetFillGeometry = new RectangleGeometry({
            rectangle: insetRectangle,
            height: 0.0,
            vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
            stRotation: STRIPE_ST_ROTATION
        });
        const fullFillGeometry = new RectangleGeometry({
            rectangle: rectangle,
            height: 0.0,
            vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat
        });

        this.stripeFillInstance = new GeometryInstance({
            id: this.id,
            geometry: insetFillGeometry
        });

        this.solidInsetFillInstance = new GeometryInstance({
            id: this.id,
            geometry: insetFillGeometry,
            attributes: {
                color: this.solidInsetFillColorAttribute
            }
        });

        this.solidFullFillInstance = new GeometryInstance({
            id: this.id,
            geometry: fullFillGeometry,
            attributes: {
                color: this.solidFullFillColorAttribute
            }
        });
    }

    setStatus(owner: TileVisualization, status?: TileLoadState) {
        if (status === undefined) {
            this.statusByVisualization.delete(owner);
        } else {
            this.statusByVisualization.set(owner, status);
        }
        this.updateOverlay();
    }

    setBorder(owner: TileVisualization, enabled: boolean) {
        if (enabled) {
            this.borderByVisualization.set(owner, true);
        } else {
            this.borderByVisualization.delete(owner);
        }
        this.updateBaseOutlineVisibility();
    }

    private updateBaseOutlineVisibility() {
        const shouldShow = [...this.borderByVisualization.values()].some(value => value);
        if (shouldShow === this.borderVisible) {
            return;
        }
        this.borderVisible = shouldShow;
        const nextColor = shouldShow ? BASE_OUTLINE_COLOR : TRANSPARENT_COLOR;
        ColorGeometryInstanceAttribute.toValue(nextColor, this.outlineColorAttribute.value);
        const state = TileBoxVisualization.getTileBoxState(this.viewIndex);
        TileBoxVisualization.updateInstanceColor(state.outlinePrimitive, this.id, nextColor);
    }

    private resolveOverlayKind(status: TileLoadState): TileOverlayKind {
        switch (status) {
            case TileLoadState.LoadingQueued:
                return TileOverlayKind.LoadingQueued;
            case TileLoadState.BackendFetching:
                return TileOverlayKind.BackendFetching;
            case TileLoadState.BackendConverting:
                return TileOverlayKind.BackendConverting;
            case TileLoadState.RenderingQueued:
                return TileOverlayKind.RenderingQueued;
            case TileLoadState.Error:
                return TileOverlayKind.Error;
            case TileLoadState.Ok:
                break;
        }
        if (this.tile.hasData() && this.tile.numFeatures === 0) {
            return TileOverlayKind.Empty;
        }
        return TileOverlayKind.None;
    }

    private updateOverlay() {
        const nextKind = this.resolveOverlayKind(Math.min(TileLoadState.Ok, ...this.statusByVisualization.values()));
        if (nextKind === this.overlayKind) {
            return;
        }
        const state = TileBoxVisualization.getTileBoxState(this.viewIndex);
        let rebuildLoading = false;
        let rebuildFetching = false;
        let rebuildConverting = false;
        let rebuildSolid = false;

        const removeSolid = () => {
            if (state.solidFillInstances.delete(this.id)) {
                rebuildSolid = true;
            }
        };

        switch (this.overlayKind) {
            case TileOverlayKind.LoadingQueued:
                if (state.loadingOutlineInstances.delete(this.id)) {
                    rebuildLoading = true;
                }
                break;
            case TileOverlayKind.BackendFetching:
                if (state.stripeFetchingInstances.delete(this.id)) {
                    rebuildFetching = true;
                }
                break;
            case TileOverlayKind.BackendConverting:
                if (state.stripeConvertingInstances.delete(this.id)) {
                    rebuildConverting = true;
                }
                break;
            case TileOverlayKind.RenderingQueued:
            case TileOverlayKind.Empty:
            case TileOverlayKind.Error:
                removeSolid();
                break;
            default:
                break;
        }

        switch (nextKind) {
            case TileOverlayKind.LoadingQueued:
                state.loadingOutlineInstances.set(this.id, this.loadingOutlineInstance);
                rebuildLoading = true;
                break;
            case TileOverlayKind.BackendFetching:
                state.stripeFetchingInstances.set(this.id, this.stripeFillInstance);
                rebuildFetching = true;
                break;
            case TileOverlayKind.BackendConverting:
                state.stripeConvertingInstances.set(this.id, this.stripeFillInstance);
                rebuildConverting = true;
                break;
            case TileOverlayKind.RenderingQueued:
                state.solidFillInstances.set(this.id, this.solidInsetFillInstance);
                ColorGeometryInstanceAttribute.toValue(RENDERING_FILL_COLOR, this.solidInsetFillColorAttribute.value);
                rebuildSolid = true;
                break;
            case TileOverlayKind.Empty:
                state.solidFillInstances.set(this.id, this.solidFullFillInstance);
                ColorGeometryInstanceAttribute.toValue(EMPTY_FILL_COLOR, this.solidFullFillColorAttribute.value);
                rebuildSolid = true;
                break;
            case TileOverlayKind.Error:
                state.solidFillInstances.set(this.id, this.solidFullFillInstance);
                ColorGeometryInstanceAttribute.toValue(ERROR_FILL_COLOR, this.solidFullFillColorAttribute.value);
                rebuildSolid = true;
                break;
            default:
                break;
        }

        this.overlayKind = nextKind;
        if (rebuildLoading) {
            TileBoxVisualization.updateLoadingOutlinePrimitive(this.viewIndex);
        }
        if (rebuildFetching) {
            TileBoxVisualization.updateStripePrimitive(this.viewIndex, "fetching");
        }
        if (rebuildConverting) {
            TileBoxVisualization.updateStripePrimitive(this.viewIndex, "converting");
        }
        if (rebuildSolid) {
            TileBoxVisualization.updateSolidFillPrimitive(this.viewIndex);
        }
        if ((rebuildLoading || rebuildFetching || rebuildConverting || rebuildSolid) && state.viewer) {
            state.viewer.scene.requestRender();
        }
    }

    private static updateInstanceColor(primitive: Primitive | null, id: bigint, color: Color) {
        if (!primitive) {
            return;
        }
        const attributes: any = primitive.getGeometryInstanceAttributes(id);
        if (attributes && attributes.color) {
            attributes.color = ColorGeometryInstanceAttribute.toValue(color);
        }
    }

    private static insetRectangle(rectangle: Rectangle, insetFraction: number) {
        const insetLon = (rectangle.east - rectangle.west) * insetFraction;
        const insetLat = (rectangle.north - rectangle.south) * insetFraction;
        return new Rectangle(
            rectangle.west + insetLon,
            rectangle.south + insetLat,
            rectangle.east - insetLon,
            rectangle.north - insetLat
        );
    }

    delete(viewIndex: number, viewer: Viewer, featureCount: number, owner: TileVisualization) {
        --this.refCount;
        this.featureCount -= featureCount;
        this.statusByVisualization.delete(owner);
        this.borderByVisualization.delete(owner);
        const state = TileBoxVisualization.getTileBoxState(viewIndex);
        if (this.refCount <= 0) {
            state.visualizations.delete(this.id);
            if (state.loadingOutlineInstances.delete(this.id)) {
                TileBoxVisualization.updateLoadingOutlinePrimitive(this.viewIndex);
            }
            if (state.stripeFetchingInstances.delete(this.id)) {
                TileBoxVisualization.updateStripePrimitive(this.viewIndex, "fetching");
            }
            if (state.stripeConvertingInstances.delete(this.id)) {
                TileBoxVisualization.updateStripePrimitive(this.viewIndex, "converting");
            }
            if (state.solidFillInstances.delete(this.id)) {
                TileBoxVisualization.updateSolidFillPrimitive(this.viewIndex);
            }
            TileBoxVisualization.updatePrimitive(viewIndex, viewer);
        } else {
            this.updateOverlay();
            this.updateBaseOutlineVisibility();
        }
    }
}

/** Bundle of a FeatureTile, a style, and a rendered Cesium visualization. */
export class TileVisualization {
    tile: FeatureTile;
    isHighDetail: boolean;
    showTileBorder: boolean = false;
    readonly viewIndex: number;

    private lowDetailVisu: TileBoxVisualization|null = null;
    private primitiveCollection: PrimitiveCollection|null = null;
    private hasHighDetailVisualization: boolean = false;
    private hasTileBorder: boolean = false;
    private renderingInProgress: boolean = false;
    private deleted: boolean = false;
    private readonly style: StyleWithIsDeleted;
    public readonly styleId: string;
    private readonly highlightMode: HighlightMode;
    private readonly featureIdSubset: string[];
    private readonly auxTileFun: (key: string)=>FeatureTile|null;
    private readonly options: Record<string, boolean|number|string>;
    private readonly pointMergeService: PointMergeService;
    private renderQueued: boolean = false;

    /**
     * Create a tile visualization.
     * @param viewIndex Index of the MapView to which is TileVisualization is dedicated.
     * @param tile The tile to visualize.
     * @param pointMergeService Instance of the central PointMergeService, used to visualize merged point features.
     * @param auxTileFun Callback which may be called to resolve external references
     *  for relation visualization.
     * @param style The style to use for visualization.
     * @param highDetail The level of detail to use. Currently,
     *  a low-detail representation is indicated by `false`, and
     *  will result in a dot representation. A high-detail representation
     *  based on the style can be triggered using `true`.
     * @param highlightMode Controls whether the visualization will run rules that
     *  have a specific highlight mode.
     * @param featureIdSubset Subset of feature IDs for visualization. If not set,
     *  all features in the tile will be visualized.
     * @param boxGrid Sets a flag to wrap this tile visualization into a bounding box
     * @param options Option values for option variables defined by the style sheet.
     */
    constructor(viewIndex: number,
                tile: FeatureTile,
                pointMergeService: PointMergeService,
                auxTileFun: (key: string) => FeatureTile | null,
                style: FeatureLayerStyle,
                highDetail: boolean,
                highlightMode: HighlightMode = coreLib.HighlightMode.NO_HIGHLIGHT,
                featureIdSubset?: string[],
                boxGrid?: boolean,
                options?: Record<string, boolean|number|string>) {
        this.tile = tile;
        this.style = style as StyleWithIsDeleted;
        this.styleId = this.style.name();
        this.isHighDetail = highDetail;
        this.renderingInProgress = false;
        this.highlightMode = highlightMode;
        this.featureIdSubset = featureIdSubset || [];
        this.deleted = false;
        this.auxTileFun = auxTileFun;
        this.showTileBorder = boxGrid === undefined ? false : boxGrid;
        this.options = options || {};
        this.pointMergeService = pointMergeService;
        this.viewIndex = viewIndex;
    }

    private effectiveStatus(): TileLoadState {
        if (this.tile.status === TileLoadState.Ok && this.renderQueued) {
            return TileLoadState.RenderingQueued;
        }
        return this.tile.status;
    }

    updateStatus(renderQueued?: boolean) {
        if (renderQueued !== undefined) {
            this.renderQueued = renderQueued;
        }
        if (this.lowDetailVisu) {
            this.lowDetailVisu.setStatus(this, this.effectiveStatus());
        }
    }

    /**
     * Actually create the visualization.
     * @param viewer {Viewer} The viewer to add the rendered entity to.
     * @return True if anything was rendered, false otherwise.
     */
    async render(viewer: Viewer) {
        if (this.renderingInProgress || this.deleted)
            return false;

        // Remove any previous render-result, as a new one is generated.
        this.destroy(viewer);
        this.deleted = false;

        // Do not continue if the style was deleted while we were waiting.
        if (this.style.isDeleted()) {
            this.updateStatus(false);
            return false;
        }

        // Create potential high-detail visualization.
        this.renderingInProgress = true;
        let returnValue = true;
        if (this.isHighDetailAndNotEmpty()) {
            returnValue = await this.tile.peekAsync(async (tileFeatureLayer: TileFeatureLayer) => {
                let wasmVisualization = new coreLib.FeatureLayerVisualization(
                    this.viewIndex,
                    this.tile.mapTileKey,
                    this.style,
                    this.options,
                    this.pointMergeService,
                    this.highlightMode,
                    this.featureIdSubset);

                let startTime = performance.now();
                wasmVisualization.addTileFeatureLayer(tileFeatureLayer);
                try {
                    wasmVisualization.run();
                }
                catch (e) {
                    console.error(`Exception while rendering: ${e}`);
                    return false;
                }

                // Try to resolve externally referenced auxiliary tiles.
                let extRefs = {requests: wasmVisualization.externalReferences()};
                if (extRefs.requests && extRefs.requests.length > 0) {
                    let response = await fetch("locate", {
                        body: JSON.stringify(extRefs, (_, value) =>
                            typeof value === 'bigint'
                                ? Number(value)
                                : value),
                        method: "POST"
                    }).catch((err)=>console.error(`Error during /locate call: ${err}`));
                    if (!response) {
                        return false;
                    }

                    let extRefsResolved = await response.json() as LocateResponse;
                    if (this.style.isDeleted()) {
                        // Do not continue if the style was deleted while we were waiting.
                        return false;
                    }

                    // Resolve located external tile IDs to actual tiles.
                    let seenTileIds = new Set<string>();
                    let auxTiles = new Array<FeatureTile>();
                    for (let resolutions of extRefsResolved.responses) {
                        for (let resolution of resolutions) {
                            if (!seenTileIds.has(resolution.tileId)) {
                                let tile = this.auxTileFun(resolution.tileId);
                                if (tile) {
                                    auxTiles.push(tile);
                                }
                                seenTileIds.add(resolution.tileId);
                            }
                        }
                    }

                    // Now we can actually parse the auxiliary layers,
                    // add them to the visualization, and let it process them.
                    await FeatureTile.peekMany(auxTiles, async (tileFeatureLayers: Array<TileFeatureLayer>) => {
                        for (let auxTile of tileFeatureLayers)
                            wasmVisualization.addTileFeatureLayer(auxTile);

                        try {
                            wasmVisualization.processResolvedExternalReferences(extRefsResolved.responses);
                        }
                        catch (e) {
                            console.error(`Exception while rendering: ${e}`);
                        }
                    });
                }

                if (!this.deleted) {
                    this.primitiveCollection = wasmVisualization.primitiveCollection();
                    for (const [mapLayerStyleRuleId, mergedPointVisualizations] of Object.entries(wasmVisualization.mergedPointFeatures())) {
                        for (let finishedCornerTile of this.pointMergeService.insert(mergedPointVisualizations as MergedPointVisualization[], this.tile.tileId, mapLayerStyleRuleId)) {
                            finishedCornerTile.render(viewer);
                        }
                    }
                }
                wasmVisualization.delete();
                let endTime = performance.now();

                // Add the render time for this style sheet as a statistic to the tile.
                let timingListKey = `render-time-${this.styleId.toLowerCase()}-${["normal", "hover", "selection"][this.highlightMode.value]}-ms`;
                let timingList = this.tile.stats.get(timingListKey);
                if (!timingList) {
                    timingList = [];
                    this.tile.stats.set(timingListKey, timingList);
                }
                timingList.push(endTime - startTime);
                return true;
            });
            if (this.primitiveCollection) {
                viewer.scene.primitives.add(this.primitiveCollection);
            }
            this.hasHighDetailVisualization = true;
        }

        // Low-detail bounding box and load-state overlays.
        this.lowDetailVisu = TileBoxVisualization.get(
            this.viewIndex,
            this.tile,
            this.tile.numFeatures,
            viewer,
            this,
            this.effectiveStatus(),
            this.showTileBorder);
        this.hasTileBorder = this.showTileBorder;

        this.renderingInProgress = false;
        this.updateStatus(false);
        if (this.deleted)
            this.destroy(viewer);
        return returnValue;
    }

    /**
     * Destroy any current visualization.
     * @param viewer {Viewer} The viewer to remove the rendered entity from.
     */
    destroy(viewer: Viewer) {
        this.deleted = true;
        if (this.renderingInProgress) {
            return;
        }

        // Remove point-merge contributions that were made by this map-layer+style visualization combo.
        let removedCornerTiles = this.pointMergeService.remove(
            this.tile.tileId,
            this.mapViewLayerStyleId());
        for (let removedCornerTile of removedCornerTiles) {
            removedCornerTile.remove(viewer);
        }

        if (this.primitiveCollection) {
            viewer.scene.primitives.remove(this.primitiveCollection);
            if (!this.primitiveCollection.isDestroyed())
                this.primitiveCollection.destroy();
            this.primitiveCollection = null;
        }
        if (this.lowDetailVisu) {
            this.lowDetailVisu.delete(this.viewIndex, viewer, this.tile.numFeatures, this);
            this.lowDetailVisu = null;
        }
        this.hasHighDetailVisualization = false;
        this.hasTileBorder = false;
    }

    /**
     * Check if the visualization is high-detail, and the
     * underlying data is not empty.
     */
    private isHighDetailAndNotEmpty() {
        return this.isHighDetail && (this.tile.numFeatures > 0 || this.tile.preventCulling);
    }

    /**
     * Check if this visualization needs re-rendering, based on
     * whether the isHighDetail flag changed.
     */
    isDirty() {
        return (
            this.isHighDetailAndNotEmpty() != this.hasHighDetailVisualization ||
            this.showTileBorder != this.hasTileBorder ||
            !this.lowDetailVisu
        );
    }

    /**
     * Combination of map name, layer name, style name and highlight mode which
     * (in combination with the tile id) uniquely identifies the rendered contents
     * of this TileVisualization as expected by the surrounding MergedPointsTiles.
     */
    private mapViewLayerStyleId(): MapViewLayerStyleRule {
        return this.pointMergeService.makeMapViewLayerStyleId(this.viewIndex, this.tile.mapName, this.tile.layerName, this.styleId, this.highlightMode);
    }

    public setStyleOption(optionId: string, value: string|number|boolean) {
        this.options[optionId] = value;
    }
}
