import {CompositeLayer, type Layer, type LayerProps, type PickingInfo} from "@deck.gl/core";
import {createErdblickVectorLayers, ErdblickVectorLayer} from "./erdblick-vector.layer";
import {createGpuTextLayerHost, GpuTextLayerHost} from "./gpu-text-layer.host";
import type {GpuScene} from "./gpu-scene.visualization";

/** Small composite over native styled drawing contributions in the view's shared GPU scene. */
export class DrawingLayer extends CompositeLayer<LayerProps & {
    scene: GpuScene;
    flattenZ: boolean;
    drawingPass: "geometry" | "interaction" | "labels";
    disabledPickIndices: Set<number>;
    drillPickEligible: boolean;
    navigationAnchorEligible: boolean;
}> {
    static override layerName = "DrawingLayer";

    /** Keep native primitive, label, mask, and picking contracts shared with ordinary maps. */
    override renderLayers(): Layer[] {
        if (this.props.drawingPass === "labels") {
            return [createGpuTextLayerHost(
                this.props.id + "-text", this.props.scene, this.props.flattenZ, "drawing"
            )];
        }
        const layers = createErdblickVectorLayers(
            this.props.id, this.props.scene, this.props.flattenZ,
            this.props.disabledPickIndices, "drawing"
        );
        return this.props.drawingPass === "geometry" ? layers.slice(0, 2) : layers.slice(2);
    }

    /** Retain the scene-global index when Deck bubbles a sublayer pick to this composite. */
    override getPickingInfo({info}: {info: PickingInfo}): PickingInfo {
        return info;
    }

    /** Rebind vector buffers and coalesce text snapshots after each shared-scene publication. */
    sceneChanged(): void {
        for (const layer of this.getSubLayers()) {
            if (layer instanceof GpuTextLayerHost || layer instanceof ErdblickVectorLayer) layer.sceneChanged();
        }
    }
}
