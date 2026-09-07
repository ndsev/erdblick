import {SolidPolygonLayer, SolidPolygonLayerProps} from "@deck.gl/layers";
import type {Texture} from "@luma.gl/core";
import type {ShaderModule} from "@luma.gl/shadertools";
import {tileGridLatToNormY, tileGridLonToNormX} from "../tile-grid-visibility";

const TILE_GRID_LAT_LIMIT = 85.05112878;
const TILE_GRID_WORLD_RING: [number, number][] = [
    [-180, -TILE_GRID_LAT_LIMIT],
    [180, -TILE_GRID_LAT_LIMIT],
    [180, TILE_GRID_LAT_LIMIT],
    [-180, TILE_GRID_LAT_LIMIT]
];
const TILE_GRID_EMPTY_TEXEL = new Uint8Array([0, 0, 0, 0]);

export const TILE_STATE_KIND_NONE = 0;
export const TILE_STATE_KIND_ERROR = 1;
export const TILE_STATE_KIND_EMPTY = 2;

/** Uniform payload for the line-only tile-grid shader module. */
interface TileGridShaderModuleProps {
    gridScale?: [number, number];
    originTilePhase?: [number, number];
    originLatitudeRadians?: number;
    lineColor?: [number, number, number, number];
    lineWidthPx?: number;
    gridMode?: number;
}

/** Uniform payload for the tile-state raster sampling shader module. */
interface TileStateShaderModuleProps {
    localMin?: [number, number];
    localSize?: [number, number];
    gridMode?: number;
    textureSize?: [number, number];
    tileStateTexture?: Texture;
}

interface TileGridCoordinateFrame {
    gridScale: [number, number];
    originLatitudeRadians: number;
    originTilePhase: [number, number];
}

/** Small numeric clamp helper used while normalizing shader uniforms. */
function clamp(value: number, minValue: number, maxValue: number): number {
    return Math.max(minValue, Math.min(maxValue, value));
}

const TILE_GRID_COMMON_VERTEX_DECL = `const float TILE_GRID_WORLD_SIZE = 512.0;
out vec2 tileGridCommonOffset;
out vec2 tileGridProjected01;
out float tileGridUsesOffsetCoordinates;`;

/** Preserves Deck's camera-relative common-space position for precise fragment interpolation. */
function tileGridCommonVertexFilter(): string {
    return `tileGridCommonOffset = geometry.position.xy;
tileGridProjected01 = (geometry.position.xy + project.commonOrigin.xy) / TILE_GRID_WORLD_SIZE;
tileGridUsesOffsetCoordinates = project.projectionMode == PROJECTION_MODE_WEB_MERCATOR_AUTO_OFFSET
    ? 1.0
    : 0.0;`;
}

/** Generates shared fragment helpers for absolute low-zoom and centered high-zoom grid coordinates. */
function tileGridCommonFragmentDecl(): string {
    return `const float TILE_GRID_WORLD_SIZE = 512.0;
const float TILE_GRID_PI = 3.14159265358979323846;
in vec2 tileGridCommonOffset;
in vec2 tileGridProjected01;
in float tileGridUsesOffsetCoordinates;

float tile_grid_mercator_to_nds_y(float mercatorY) {
    float mercatorN = TILE_GRID_PI * (1.0 - 2.0 * clamp(mercatorY, 0.0, 1.0));
    float latitudeRadians = atan(0.5 * (exp(mercatorN) - exp(-mercatorN)));
    return (0.5 * TILE_GRID_PI - latitudeRadians) / TILE_GRID_PI;
}

vec2 tile_grid_absolute_normalized_coords(float gridMode) {
    // Deck common-space Y grows northward, while XYZ/NDS tile rows grow southward.
    vec2 normalizedCoords = vec2(tileGridProjected01.x, 1.0 - tileGridProjected01.y);
    if (gridMode > 0.5) {
        normalizedCoords.y = tile_grid_mercator_to_nds_y(normalizedCoords.y);
    }
    return normalizedCoords;
}

float tile_grid_latitude_delta(float commonOffsetY, float originLatitudeRadians) {
    float mercatorDelta = commonOffsetY * (2.0 * TILE_GRID_PI / TILE_GRID_WORLD_SIZE);
    float sinOrigin = sin(originLatitudeRadians);
    float cosOrigin = cos(originLatitudeRadians);
    if (abs(mercatorDelta) < 0.01) {
        float deltaSquared = mercatorDelta * mercatorDelta;
        return cosOrigin * mercatorDelta
            - 0.5 * sinOrigin * cosOrigin * deltaSquared
            + cosOrigin * (2.0 * sinOrigin * sinOrigin - 1.0)
                * deltaSquared * mercatorDelta / 6.0;
    }
    float originMercator = log(tan(0.25 * TILE_GRID_PI + 0.5 * originLatitudeRadians));
    float mercator = originMercator + mercatorDelta;
    float latitudeRadians = atan(0.5 * (exp(mercator) - exp(-mercator)));
    return latitudeRadians - originLatitudeRadians;
}

vec2 tile_grid_offset_to_tile_delta(
    float gridMode,
    vec2 gridScale,
    float originLatitudeRadians
) {
    float deltaY = gridMode > 0.5
        ? -tile_grid_latitude_delta(tileGridCommonOffset.y, originLatitudeRadians) / TILE_GRID_PI
        : -tileGridCommonOffset.y / TILE_GRID_WORLD_SIZE;
    return vec2(
        tileGridCommonOffset.x / TILE_GRID_WORLD_SIZE * gridScale.x,
        deltaY * gridScale.y
    );
}`;
}

/** Returns a stable grid phase and scale around Deck's float32 projection origin. */
function tileGridCoordinateFrame(
    gridMode: "xyz" | "nds",
    localSize: [number, number],
    localCellCount: [number, number],
    viewport: object
): TileGridCoordinateFrame {
    const gridScale: [number, number] = [
        localCellCount[0] / Math.max(1e-12, localSize[0]),
        localCellCount[1] / Math.max(1e-12, localSize[1])
    ];
    // Deck rounds the auto-offset projection origin to float32 before exposing it to GLSL.
    const originLongitude = Math.fround(tileGridViewportCoordinate(viewport, "longitude"));
    const originLatitude = Math.fround(tileGridViewportCoordinate(viewport, "latitude"));
    const originX = tileGridLonToNormX(originLongitude);
    const originY = tileGridLatToNormY(originLatitude, gridMode);
    const originTile: [number, number] = [
        originX * gridScale[0],
        originY * gridScale[1]
    ];
    return {
        gridScale,
        originLatitudeRadians: originLatitude * Math.PI / 180,
        originTilePhase: [
            originTile[0] - Math.round(originTile[0]),
            originTile[1] - Math.round(originTile[1])
        ]
    };
}

/** Reads one optional geospatial viewport coordinate without assuming a concrete Deck viewport subtype. */
function tileGridViewportCoordinate(viewport: object, key: "longitude" | "latitude"): number {
    const value: unknown = Reflect.get(viewport, key);
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Shader module that draws grid lines directly in fragment space over a single quad. */
const tileGridOverlayShaderModule: ShaderModule = {
    name: "tileGridOverlay",
    vs: `\
uniform tileGridOverlayUniforms {
  vec2 gridScale;
  vec2 originTilePhase;
  float originLatitudeRadians;
  vec4 lineColor;
  float lineWidthPx;
  float gridMode;
} tileGridOverlay;
`,
    fs: `\
uniform tileGridOverlayUniforms {
  vec2 gridScale;
  vec2 originTilePhase;
  float originLatitudeRadians;
  vec4 lineColor;
  float lineWidthPx;
  float gridMode;
} tileGridOverlay;
`,
    uniformTypes: {
        gridScale: "vec2<f32>",
        originTilePhase: "vec2<f32>",
        originLatitudeRadians: "f32",
        lineColor: "vec4<f32>",
        lineWidthPx: "f32",
        gridMode: "f32"
    },
    getUniforms: (opts?: TileGridShaderModuleProps) => {
        const gridScale = opts?.gridScale ?? [1, 1];
        const originTilePhase = opts?.originTilePhase ?? [0, 0];
        const lineColor = opts?.lineColor ?? [1, 1, 1, 1];
        const lineWidthPx = opts?.lineWidthPx ?? 1.0;
        return {
            gridScale: [
                Math.max(1, Number.isFinite(gridScale[0]) ? gridScale[0] : 1),
                Math.max(1, Number.isFinite(gridScale[1]) ? gridScale[1] : 1)
            ],
            originTilePhase: [
                Number.isFinite(originTilePhase[0]) ? originTilePhase[0] : 0,
                Number.isFinite(originTilePhase[1]) ? originTilePhase[1] : 0
            ],
            originLatitudeRadians: Number.isFinite(opts?.originLatitudeRadians)
                ? opts!.originLatitudeRadians!
                : 0,
            lineColor: [
                clamp(lineColor[0], 0, 1),
                clamp(lineColor[1], 0, 1),
                clamp(lineColor[2], 0, 1),
                clamp(lineColor[3], 0, 1)
            ],
            lineWidthPx: Math.max(0.5, lineWidthPx),
            gridMode: opts?.gridMode ?? 0
        };
    }
};

/** Shader module that samples a tile-state raster texture using the same local coordinate remap as the grid. */
const tileGridStateOverlayShaderModule: ShaderModule = {
    name: "tileGridStateOverlay",
    vs: `\
uniform tileGridStateOverlayUniforms {
  vec2 localMin;
  vec2 localSize;
  vec2 textureSize;
  float gridMode;
} tileGridStateOverlay;
`,
    fs: `\
uniform tileGridStateOverlayUniforms {
  vec2 localMin;
  vec2 localSize;
  vec2 textureSize;
  float gridMode;
} tileGridStateOverlay;
uniform sampler2D tileGridStateOverlayTexture;
`,
    uniformTypes: {
        localMin: "vec2<f32>",
        localSize: "vec2<f32>",
        textureSize: "vec2<f32>",
        gridMode: "f32"
    },
    getUniforms: (opts?: TileStateShaderModuleProps) => {
        const localMin = opts?.localMin ?? [0, 0];
        const localSize = opts?.localSize ?? [1, 1];
        const textureSize = opts?.textureSize ?? [1, 1];
        return {
            localMin: [
                Number.isFinite(localMin[0]) ? localMin[0] : 0,
                Number.isFinite(localMin[1]) ? localMin[1] : 0
            ],
            localSize: [
                Math.max(1e-6, Number.isFinite(localSize[0]) ? localSize[0] : 1),
                Math.max(1e-6, Number.isFinite(localSize[1]) ? localSize[1] : 1)
            ],
            textureSize: [
                Math.max(1, Number.isFinite(textureSize[0]) ? textureSize[0] : 1),
                Math.max(1, Number.isFinite(textureSize[1]) ? textureSize[1] : 1)
            ],
            gridMode: opts?.gridMode ?? 0,
            tileGridStateOverlayTexture: opts?.tileStateTexture
        };
    }
};

/** Creates the texture that backs the tile-state overlay, falling back to a transparent 1x1 texel. */
function createTileStateTexture(device: any, imageData: ImageData | null): Texture {
    if (!imageData) {
        return device.createTexture({
            format: "rgba8unorm",
            data: TILE_GRID_EMPTY_TEXEL,
            width: 1,
            height: 1,
            sampler: {
                minFilter: "nearest",
                magFilter: "nearest",
                mipmapFilter: "nearest",
                addressModeU: "clamp-to-edge",
                addressModeV: "clamp-to-edge"
            }
        });
    }
    return device.createTexture({
        format: "rgba8unorm",
        data: imageData.data,
        width: imageData.width,
        height: imageData.height,
        sampler: {
            minFilter: "nearest",
            magFilter: "nearest",
            mipmapFilter: "nearest",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge"
        }
    });
}

/** Single polygon covering a contiguous tile-grid overlay region. */
export interface TileGridOverlayDatum {
    polygon: [number, number][];
}

/** Props for the shader-driven tile-grid line overlay. */
export interface TileGridOverlayLayerProps extends SolidPolygonLayerProps<TileGridOverlayDatum> {
    gridMode: "xyz" | "nds";
    localMin: [number, number];
    localSize: [number, number];
    subdivisionX: number;
    subdivisionY: number;
    lineColor: [number, number, number, number];
    lineWidthPixels: number;
}

/** Props for the shader-driven tile-state raster overlay. */
export interface TileGridStateOverlayLayerProps extends SolidPolygonLayerProps<TileGridOverlayDatum> {
    gridMode: "xyz" | "nds";
    localMin: [number, number];
    localSize: [number, number];
    imageData: ImageData | null;
}

interface TileGridStateOverlayLayerState {
    tileStateTexture: Texture;
}

/**
 * Single-layer screen-space tile grid overlay rendered by shader evaluation.
 * Camera-relative grid phases preserve line precision in Deck's high-zoom
 * projection mode without sacrificing exact low-zoom Mercator conversion.
 */
export class TileGridOverlayLayer extends SolidPolygonLayer<TileGridOverlayDatum, TileGridOverlayLayerProps> {
    static override layerName = "TileGridOverlayLayer";

    /** Injects the custom shader modules and fragment logic that renders the grid in screen space. */
    override getShaders(type: any): any {
        const baseShaders = super.getShaders(type);
        const existingVsDecl = baseShaders.inject?.["vs:#decl"] ?? "";
        const existingVsFilter = baseShaders.inject?.["vs:DECKGL_FILTER_COLOR"] ?? "";
        const existingDecl = baseShaders.inject?.["fs:#decl"] ?? "";
        const existingFilter = baseShaders.inject?.["fs:DECKGL_FILTER_COLOR"] ?? "";
        return {
            ...baseShaders,
            modules: [...(baseShaders.modules ?? []), tileGridOverlayShaderModule],
            inject: {
                ...(baseShaders.inject ?? {}),
                "vs:#decl": `${existingVsDecl}
${TILE_GRID_COMMON_VERTEX_DECL}`,
                "vs:DECKGL_FILTER_COLOR": `${existingVsFilter}
${tileGridCommonVertexFilter()}`,
                "fs:#decl": `${existingDecl}
${tileGridCommonFragmentDecl()}

vec2 tile_grid_line_coords() {
    if (tileGridUsesOffsetCoordinates > 0.5) {
        return tileGridOverlay.originTilePhase + tile_grid_offset_to_tile_delta(
            tileGridOverlay.gridMode,
            tileGridOverlay.gridScale,
            tileGridOverlay.originLatitudeRadians
        );
    }
    return tile_grid_absolute_normalized_coords(tileGridOverlay.gridMode)
        * tileGridOverlay.gridScale;
}

float tile_grid_line_mask(vec2 tileCoords) {
    vec2 edge = abs(tileCoords - round(tileCoords));
    float pixelSpanX = max(fwidth(tileCoords.x), 1e-6);
    float pixelSpanY = max(fwidth(tileCoords.y), 1e-6);
    float distPxToVertical = edge.x / pixelSpanX;
    float distPxToHorizontal = edge.y / pixelSpanY;
    float halfWidthPx = max(0.5 * tileGridOverlay.lineWidthPx, 0.5);
    float verticalMask = 1.0 - smoothstep(
        max(0.0, halfWidthPx - 0.5),
        halfWidthPx + 0.5,
        distPxToVertical
    );
    float horizontalMask = 1.0 - smoothstep(
        max(0.0, halfWidthPx - 0.5),
        halfWidthPx + 0.5,
        distPxToHorizontal
    );
    verticalMask *= smoothstep(1.0, 3.0, 1.0 / pixelSpanX);
    horizontalMask *= smoothstep(1.0, 3.0, 1.0 / pixelSpanY);
    return max(verticalMask, horizontalMask);
}`,
                "fs:DECKGL_FILTER_COLOR": `${existingFilter}
float mask = tile_grid_line_mask(tile_grid_line_coords());
color = vec4(
    tileGridOverlay.lineColor.rgb,
    tileGridOverlay.lineColor.a * mask * layer.opacity
);`
            }
        };
    }

    /** Normalizes the public props into shader-module uniforms before delegating to deck. */
    override draw(params: any): void {
        const lineColor = this.props.lineColor ?? [255, 255, 255, 255];
        const coordinateFrame = tileGridCoordinateFrame(
            this.props.gridMode,
            this.props.localSize,
            [this.props.subdivisionX, this.props.subdivisionY],
            this.context.viewport
        );
        this.setShaderModuleProps({
            tileGridOverlay: {
                gridScale: coordinateFrame.gridScale,
                originTilePhase: coordinateFrame.originTilePhase,
                originLatitudeRadians: coordinateFrame.originLatitudeRadians,
                lineColor: [
                    lineColor[0] / 255,
                    lineColor[1] / 255,
                    lineColor[2] / 255,
                    lineColor[3] / 255
                ],
                lineWidthPx: this.props.lineWidthPixels,
                gridMode: this.props.gridMode === "nds" ? 1 : 0
            } satisfies TileGridShaderModuleProps
        });
        super.draw(params);
    }
}

/**
 * Shader-backed tile-state overlay that samples the cell colors from a raster
 * texture while using the exact same NDS remap as the grid lines.
 */
export class TileGridStateOverlayLayer extends SolidPolygonLayer<TileGridOverlayDatum, TileGridStateOverlayLayerProps> {
    static override layerName = "TileGridStateOverlayLayer";

    declare state: SolidPolygonLayer<TileGridOverlayDatum, TileGridStateOverlayLayerProps>["state"] & TileGridStateOverlayLayerState;

    /** Creates the initial empty texture used until tile-state data is available. */
    override initializeState(): void {
        super.initializeState();
        this.state.tileStateTexture = createTileStateTexture(this.context.device, null);
    }

    /** Rebuilds the backing texture only when the caller supplied new image data. */
    override updateState(params: any): void {
        super.updateState(params);
        if (params.props.imageData === params.oldProps.imageData) {
            return;
        }
        this.state.tileStateTexture?.delete();
        this.state.tileStateTexture = createTileStateTexture(this.context.device, params.props.imageData);
    }

    /** Releases the backing texture before the layer is finalized. */
    override finalizeState(context: any): void {
        this.state.tileStateTexture?.delete();
        super.finalizeState(context);
    }

    /** Injects the shader logic that samples the tile-state raster in local tile-grid coordinates. */
    override getShaders(type: any): any {
        const baseShaders = super.getShaders(type);
        const existingVsDecl = baseShaders.inject?.["vs:#decl"] ?? "";
        const existingVsFilter = baseShaders.inject?.["vs:DECKGL_FILTER_COLOR"] ?? "";
        const existingDecl = baseShaders.inject?.["fs:#decl"] ?? "";
        const existingFilter = baseShaders.inject?.["fs:DECKGL_FILTER_COLOR"] ?? "";
        return {
            ...baseShaders,
            modules: [...(baseShaders.modules ?? []), tileGridStateOverlayShaderModule],
            inject: {
                ...(baseShaders.inject ?? {}),
                "vs:#decl": `${existingVsDecl}
${TILE_GRID_COMMON_VERTEX_DECL}`,
                "vs:DECKGL_FILTER_COLOR": `${existingVsFilter}
${tileGridCommonVertexFilter()}`,
                "fs:#decl": `${existingDecl}
${tileGridCommonFragmentDecl()}

vec2 tile_grid_state_local_coords() {
    return (
        tile_grid_absolute_normalized_coords(tileGridStateOverlay.gridMode)
            - tileGridStateOverlay.localMin
    ) / tileGridStateOverlay.localSize;
}

vec4 tile_grid_state_color(vec2 localCoords) {
    vec2 clampedCoords = clamp(localCoords, vec2(0.0), vec2(1.0));
    vec2 texelIndex = floor(clampedCoords * tileGridStateOverlay.textureSize);
    texelIndex = min(texelIndex, tileGridStateOverlay.textureSize - 1.0);
    vec2 uv = (texelIndex + 0.5) / tileGridStateOverlay.textureSize;
    return texture(tileGridStateOverlayTexture, uv);
}`,
                "fs:DECKGL_FILTER_COLOR": `${existingFilter}
vec4 stateColor = tile_grid_state_color(tile_grid_state_local_coords());
color = vec4(stateColor.rgb, stateColor.a * layer.opacity);`
            }
        };
    }

    /** Normalizes the public props into shader-module uniforms before delegating to deck. */
    override draw(params: any): void {
        this.setShaderModuleProps({
            tileGridStateOverlay: {
                localMin: this.props.localMin,
                localSize: this.props.localSize,
                textureSize: [
                    this.state.tileStateTexture?.width ?? 1,
                    this.state.tileStateTexture?.height ?? 1
                ],
                gridMode: this.props.gridMode === "nds" ? 1 : 0,
                tileStateTexture: this.state.tileStateTexture
            } satisfies TileStateShaderModuleProps
        });
        super.draw(params);
    }
}

/** Returns the default full-world quad used when callers need a single overlay datum. */
export function tileGridOverlayData(): TileGridOverlayDatum[] {
    return [{polygon: TILE_GRID_WORLD_RING}];
}
