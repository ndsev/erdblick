import {
    COORDINATE_SYSTEM,
    CompositeLayer,
    Layer,
    project32,
    type LayerProps,
    type UpdateParameters
} from "@deck.gl/core";
import {SolidPolygonLayer} from "@deck.gl/layers";
import {Buffer} from "@luma.gl/core";
import {Geometry, Model} from "@luma.gl/engine";
import type {LocationPolygon} from "../render-view";
import {buildLocationOutlineBuffer, LOCATION_OUTLINE_RECORD_FLOATS} from "./location-outline-buffer";
import {LOCATION_OUTLINE_FRAGMENT_SHADER, LOCATION_OUTLINE_VERTEX_SHADER} from "./location-outline.shaders";

/** Immutable, already clipped polygons shared by the fill and complete boundary. */
type LocationAreaProps = LayerProps & {data: LocationPolygon[]};

/** Stable fill accessor so opacity clones never invalidate polygon tessellation. */
function getLocationPolygon(polygon: LocationPolygon): LocationPolygon { return polygon; }

/** WebGL outline with one shared vertex record per ring point and no uploads during camera motion/fading. */
export class LocationOutlineLayer extends Layer<LocationAreaProps> {
    static override layerName = "LocationOutlineLayer";
    override state!: {model: Model; buffer?: Buffer; numInstances: number};

    /** The interleaved buffer is authoritative; Deck need not allocate accessor/picking attributes. */
    protected override _getAttributeManager(): null { return null; }

    /** Creates the same six-vertex segment envelope used by PathLayer, with precomputed joins. */
    override initializeState(): void {
        const stride = LOCATION_OUTLINE_RECORD_FLOATS * Float32Array.BYTES_PER_ELEMENT;
        this.setState({model: new Model(this.context.device, {
            ...this.getShaders({vs: LOCATION_OUTLINE_VERTEX_SHADER, fs: LOCATION_OUTLINE_FRAGMENT_SHADER, modules: [project32]}),
            id: this.props.id,
            isInstanced: true,
            bufferLayout: [{name: "vertices", stepMode: "instance", byteStride: stride, attributes: [
                {attribute: "startPosition", format: "float32x4", byteOffset: 0},
                {attribute: "startJoin", format: "float32x4", byteOffset: 16},
                {attribute: "startInfo", format: "float32x2", byteOffset: 32},
                // WebGL sliding attributes share consecutive records, avoiding duplicated endpoints.
                {attribute: "endPosition", format: "float32x4", byteOffset: stride},
                {attribute: "endJoin", format: "float32x4", byteOffset: stride + 16},
                {attribute: "endInfo", format: "float32x2", byteOffset: stride + 32}
            ]}],
            geometry: new Geometry({
                topology: "triangle-list",
                indices: new Uint16Array([0, 1, 2, 1, 4, 2, 1, 3, 4, 3, 5, 4]),
                attributes: {positions: {size: 2, value: new Float32Array([0, 0, 0, -1, 0, 1, 1, -1, 1, 1, 1, 0])}}
            })
        })});
    }

    /** Prepares and uploads a new boundary only when the geometry changes, never on opacity updates. */
    override updateState({changeFlags}: UpdateParameters<this>): void {
        if (!changeFlags.dataChanged) return;
        const vertices = buildLocationOutlineBuffer(this.props.data);
        const buffer = vertices.length ? this.context.device.createBuffer({data: vertices, usage: Buffer.VERTEX}) : undefined;
        this.state.buffer?.destroy();
        this.setState({buffer, numInstances: Math.max(0, vertices.length / LOCATION_OUTLINE_RECORD_FLOATS - 1)});
        if (buffer) this.state.model.setAttributes({vertices: buffer});
    }

    /** Deck supplies the current projection and opacity uniforms to the persistent luma model. */
    override draw(): void {
        if (this.state.buffer && !this.state.model.draw(this.context.renderPass)) this.setNeedsRedraw();
    }

    /** Releases both the persistent boundary buffer and model when the highlight expires or is replaced. */
    override finalizeState(): void {
        this.state.model?.destroy(); // Initialization failures can reach teardown before a model exists.
        this.state.buffer?.destroy();
    }
}

/** Combines Deck's indexed polygon fill with the specialized, full-detail luma outline. */
export class LocationAreaLayer extends CompositeLayer<LocationAreaProps> {
    static override layerName = "LocationAreaLayer";

    /** Keeps fill and outline on identical clipped rings while allowing their own coordinate formats. */
    override renderLayers() {
        return [
            new SolidPolygonLayer<LocationPolygon>(this.getSubLayerProps({
                id: "fill", data: this.props.data, getPolygon: getLocationPolygon, onError: this.props.onError,
                getFillColor: [0, 255, 255, 51], extruded: false,
                coordinateSystem: COORDINATE_SYSTEM.LNGLAT, wrapLongitude: false, pickable: false
            })),
            new LocationOutlineLayer(this.getSubLayerProps({
                id: "outline", data: this.props.data, onError: this.props.onError,
                coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, wrapLongitude: false, pickable: false
            }))
        ];
    }
}
