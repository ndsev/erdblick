import {FeatureTile} from "../../mapdata/features.model";
import {coreLib} from "../../integrations/wasm";
import {
    Color,
    ColorGeometryInstanceAttribute,
    GeometryInstance,
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
    Empty = 1,
    Error = 2,
}

const BASE_OUTLINE_COLOR = Color.DIMGRAY.withAlpha(0.5);
const TRANSPARENT_COLOR = Color.WHITE.withAlpha(0.0);
const EMPTY_FILL_COLOR = Color.GRAY.withAlpha(0.2);
const ERROR_FILL_COLOR = Color.RED.withAlpha(0.25);

/**
 * Low-detail tile box renderer.
 *
 * This intentionally no longer visualizes per-tile backend load states.
 * It only keeps optional tile borders and static empty/error overlays.
 */
export class CesiumTileBoxVisualization {
    static tileBoxStatePerView: {
        visualizations: Map<bigint, CesiumTileBoxVisualization>,
        outlinePrimitive: Primitive | null,
        solidFillPrimitive: Primitive | null,
        solidFillInstances: Map<bigint, GeometryInstance>,
        viewer: Viewer | null
    }[] = [];

    static getTileBoxState(viewIndex: number) {
        while (viewIndex >= this.tileBoxStatePerView.length) {
            this.tileBoxStatePerView.push({
                visualizations: new Map<bigint, CesiumTileBoxVisualization>(),
                outlinePrimitive: null,
                solidFillPrimitive: null,
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
        showBorder: boolean = false
    ): CesiumTileBoxVisualization {
        const state = this.getTileBoxState(viewIndex);
        state.viewer = viewer;
        if (!state.visualizations.has(tile.tileId)) {
            state.visualizations.set(tile.tileId, new CesiumTileBoxVisualization(viewIndex, tile));
            CesiumTileBoxVisualization.updatePrimitive(viewIndex, viewer);
        }
        const result = state.visualizations.get(tile.tileId)!;
        ++result.refCount;
        result.featureCount += featureCount;
        result.setBorder(owner, showBorder);
        result.updateOverlay();
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
                    depthTest: {enabled: true},
                    depthMask: false
                }
            }),
            asynchronous: false
        }));
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
                    depthTest: {enabled: true},
                    depthMask: false
                }
            }),
            asynchronous: false
        }));
    }

    refCount: number = 0;
    featureCount: number = 0;
    private readonly id: bigint;
    private readonly tile: FeatureTile;
    private readonly viewIndex: number;
    private outlineColorAttribute: ColorGeometryInstanceAttribute;
    private solidFullFillColorAttribute: ColorGeometryInstanceAttribute;
    private outlineInstance: GeometryInstance;
    private solidFullFillInstance: GeometryInstance;
    private borderByVisualization = new Map<CesiumTileVisualization, boolean>();
    private overlayKind: TileOverlayKind = TileOverlayKind.None;
    private borderVisible: boolean = false;

    constructor(viewIndex: number, tile: FeatureTile) {
        this.id = tile.tileId;
        this.tile = tile;
        this.viewIndex = viewIndex;

        const tileBox = coreLib.getTileBox(BigInt(tile.tileId));
        const rectangle = Rectangle.fromDegrees(...tileBox);

        const outlineGeometry = RectangleOutlineGeometry.createGeometry(new RectangleOutlineGeometry({
            rectangle: rectangle,
            height: 0.0
        }));
        if (!outlineGeometry) {
            console.error("Failed to create RectangleOutlineGeometry!");
        }

        this.outlineColorAttribute = ColorGeometryInstanceAttribute.fromColor(TRANSPARENT_COLOR);
        this.solidFullFillColorAttribute = ColorGeometryInstanceAttribute.fromColor(TRANSPARENT_COLOR);

        this.outlineInstance = new GeometryInstance({
            id: this.id,
            geometry: outlineGeometry!,
            attributes: {
                color: this.outlineColorAttribute
            }
        });

        const fullFillGeometry = new RectangleGeometry({
            rectangle: rectangle,
            height: 0.0,
            vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat
        });
        this.solidFullFillInstance = new GeometryInstance({
            id: this.id,
            geometry: fullFillGeometry,
            attributes: {
                color: this.solidFullFillColorAttribute
            }
        });
    }

    setStatus(_owner: CesiumTileVisualization, _status?: unknown) {
        // Load-state overlays are disabled; kept for API compatibility.
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
        const shouldShow = [...this.borderByVisualization.values()].some(Boolean);
        if (shouldShow === this.borderVisible) {
            return;
        }
        this.borderVisible = shouldShow;
        const nextColor = shouldShow ? BASE_OUTLINE_COLOR : TRANSPARENT_COLOR;
        ColorGeometryInstanceAttribute.toValue(nextColor, this.outlineColorAttribute.value);
        const state = CesiumTileBoxVisualization.getTileBoxState(this.viewIndex);
        CesiumTileBoxVisualization.updateInstanceColor(state.outlinePrimitive, this.id, nextColor);
    }

    private resolveOverlayKind(): TileOverlayKind {
        if (this.tile.error) {
            return TileOverlayKind.Error;
        }
        if (this.tile.hasData() && this.tile.numFeatures === 0) {
            return TileOverlayKind.Empty;
        }
        return TileOverlayKind.None;
    }

    private updateOverlay() {
        const nextKind = this.resolveOverlayKind();
        if (nextKind === this.overlayKind) {
            return;
        }

        const state = CesiumTileBoxVisualization.getTileBoxState(this.viewIndex);
        let rebuildSolid = false;

        if (this.overlayKind !== TileOverlayKind.None) {
            if (state.solidFillInstances.delete(this.id)) {
                rebuildSolid = true;
            }
        }

        if (nextKind === TileOverlayKind.Empty || nextKind === TileOverlayKind.Error) {
            state.solidFillInstances.set(this.id, this.solidFullFillInstance);
            ColorGeometryInstanceAttribute.toValue(
                nextKind === TileOverlayKind.Error ? ERROR_FILL_COLOR : EMPTY_FILL_COLOR,
                this.solidFullFillColorAttribute.value);
            rebuildSolid = true;
        }

        this.overlayKind = nextKind;
        if (rebuildSolid) {
            CesiumTileBoxVisualization.updateSolidFillPrimitive(this.viewIndex);
        }
        if (rebuildSolid && state.viewer) {
            state.viewer.scene.requestRender();
        }
    }

    private static updateInstanceColor(primitive: Primitive | null, id: bigint, color: Color) {
        if (!primitive || !primitive.ready) {
            return;
        }
        const attributes: any = primitive.getGeometryInstanceAttributes(id);
        if (attributes && attributes.color) {
            attributes.color = ColorGeometryInstanceAttribute.toValue(color);
        }
    }

    delete(viewIndex: number, viewer: Viewer, featureCount: number, owner: CesiumTileVisualization) {
        --this.refCount;
        this.featureCount -= featureCount;
        this.borderByVisualization.delete(owner);
        const state = CesiumTileBoxVisualization.getTileBoxState(viewIndex);
        if (this.refCount <= 0) {
            state.visualizations.delete(this.id);
            if (state.solidFillInstances.delete(this.id)) {
                CesiumTileBoxVisualization.updateSolidFillPrimitive(this.viewIndex);
            }
            CesiumTileBoxVisualization.updatePrimitive(viewIndex, viewer);
            return;
        }
        this.updateOverlay();
        this.updateBaseOutlineVisibility();
    }
}
