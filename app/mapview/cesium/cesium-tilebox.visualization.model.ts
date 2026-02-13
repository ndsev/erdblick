import {FeatureTile} from "../../mapdata/features.model";
import {TileLoadState} from "../../mapdata/tilestream";
import {coreLib} from "../../integrations/wasm";
import {
    Color,
    ColorGeometryInstanceAttribute,
    GeometryInstance,
    Material,
    MaterialAppearance,
    PerInstanceColorAppearance,
    Primitive,
    Rectangle,
    RectangleGeometry,
    RectangleOutlineGeometry,
    Viewer
} from "../../integrations/cesium";
import type {CesiumTileVisualization} from "./cesium-tile.visualization.model";

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
export class CesiumTileBoxVisualization {
    static tileBoxStatePerView: {
        visualizations: Map<bigint, CesiumTileBoxVisualization>,
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
                visualizations: new Map<bigint, CesiumTileBoxVisualization>(),
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
        owner: CesiumTileVisualization,
        status?: TileLoadState,
        showBorder: boolean = false
    ): CesiumTileBoxVisualization {
        const state = this.getTileBoxState(viewIndex);
        state.viewer = viewer;
        if (!state.visualizations.has(tile.tileId)) {
            state.visualizations.set(
                tile.tileId, new CesiumTileBoxVisualization(viewIndex, tile));
            CesiumTileBoxVisualization.updatePrimitive(viewIndex, viewer);
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
            material: CesiumTileBoxVisualization.getStripeMaterial(kind),
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
    private statusByVisualization = new Map<CesiumTileVisualization, TileLoadState | undefined>();
    private borderByVisualization = new Map<CesiumTileVisualization, boolean>();
    private overlayKind: TileOverlayKind = TileOverlayKind.None;
    private borderVisible: boolean = false;

    constructor(viewIndex: number, tile: FeatureTile) {
        this.id = tile.tileId;
        this.tile = tile;
        this.viewIndex = viewIndex;

        const tileBox = coreLib.getTileBox(BigInt(tile.tileId));
        const rectangle = Rectangle.fromDegrees(...tileBox);
        const insetRectangle = CesiumTileBoxVisualization.insetRectangle(rectangle, INSET_FRACTION);

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

    setStatus(owner: CesiumTileVisualization, status?: TileLoadState) {
        if (status === undefined) {
            this.statusByVisualization.delete(owner);
        } else {
            this.statusByVisualization.set(owner, status);
        }
        this.updateOverlay();
    }

    setBorder(owner: CesiumTileVisualization, enabled: boolean) {
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
        const state = CesiumTileBoxVisualization.getTileBoxState(this.viewIndex);
        CesiumTileBoxVisualization.updateInstanceColor(state.outlinePrimitive, this.id, nextColor);
    }

    private aggregateStatus(): TileLoadState | undefined {
        let leastStatus: TileLoadState | undefined = undefined;
        for (const status of this.statusByVisualization.values()) {
            if (status === undefined) {
                continue;
            }
            if (leastStatus === undefined || status < leastStatus) {
                leastStatus = status;
            }
        }
        return leastStatus;
    }

    private resolveOverlayKind(status: TileLoadState | undefined): TileOverlayKind {
        if (status !== undefined) {
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
                default:
                    return TileOverlayKind.None;
            }
        }
        if (this.tile.hasData() && this.tile.numFeatures === 0) {
            return TileOverlayKind.Empty;
        }
        return TileOverlayKind.None;
    }

    private updateOverlay() {
        const nextKind = this.resolveOverlayKind(this.aggregateStatus());
        if (nextKind === this.overlayKind) {
            return;
        }
        const state = CesiumTileBoxVisualization.getTileBoxState(this.viewIndex);
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
            CesiumTileBoxVisualization.updateLoadingOutlinePrimitive(this.viewIndex);
        }
        if (rebuildFetching) {
            CesiumTileBoxVisualization.updateStripePrimitive(this.viewIndex, "fetching");
        }
        if (rebuildConverting) {
            CesiumTileBoxVisualization.updateStripePrimitive(this.viewIndex, "converting");
        }
        if (rebuildSolid) {
            CesiumTileBoxVisualization.updateSolidFillPrimitive(this.viewIndex);
        }
        if ((rebuildLoading || rebuildFetching || rebuildConverting || rebuildSolid) && state.viewer) {
            state.viewer.scene.requestRender();
        }
    }

    private static updateInstanceColor(primitive: Primitive | null, id: bigint, color: Color) {
        if (!primitive) {
            return;
        }
        if (!primitive.ready) {
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

    delete(viewIndex: number, viewer: Viewer, featureCount: number, owner: CesiumTileVisualization) {
        --this.refCount;
        this.featureCount -= featureCount;
        this.statusByVisualization.delete(owner);
        this.borderByVisualization.delete(owner);
        const state = CesiumTileBoxVisualization.getTileBoxState(viewIndex);
        if (this.refCount <= 0) {
            state.visualizations.delete(this.id);
            if (state.loadingOutlineInstances.delete(this.id)) {
                CesiumTileBoxVisualization.updateLoadingOutlinePrimitive(this.viewIndex);
            }
            if (state.stripeFetchingInstances.delete(this.id)) {
                CesiumTileBoxVisualization.updateStripePrimitive(this.viewIndex, "fetching");
            }
            if (state.stripeConvertingInstances.delete(this.id)) {
                CesiumTileBoxVisualization.updateStripePrimitive(this.viewIndex, "converting");
            }
            if (state.solidFillInstances.delete(this.id)) {
                CesiumTileBoxVisualization.updateSolidFillPrimitive(this.viewIndex);
            }
            CesiumTileBoxVisualization.updatePrimitive(viewIndex, viewer);
        } else {
            this.updateOverlay();
            this.updateBaseOutlineVisibility();
        }
    }
}
