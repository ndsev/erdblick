import {SolidPolygonLayer, SolidPolygonLayerProps} from "@deck.gl/layers";
import type {Texture} from "@luma.gl/core";
import type {ShaderModule} from "@luma.gl/shadertools";

const TILE_GRID_MAX_LEVEL_COUNT = 16;
const TILE_GRID_MIN_LEVEL = 0;
const TILE_GRID_MAX_LEVEL = 22;
const TILE_GRID_LAT_LIMIT = 85.05112878;
const TILE_GRID_WORLD_RING: [number, number][] = [
    [-180, -TILE_GRID_LAT_LIMIT],
    [180, -TILE_GRID_LAT_LIMIT],
    [180, TILE_GRID_LAT_LIMIT],
    [-180, TILE_GRID_LAT_LIMIT]
];
const TILE_GRID_IDENTITY_CORRECTION: [number, number, number] = [0, 1, 0];
const TILE_GRID_EMPTY_TEXEL = new Uint8Array([0, 0, 0, 0]);

export const TILE_STATE_KIND_NONE = 0;
export const TILE_STATE_KIND_ERROR = 1;
export const TILE_STATE_KIND_EMPTY = 2;

interface TileGridShaderModuleProps {
    localMin?: [number, number];
    localSize?: [number, number];
    subdivisionsX?: number[];
    subdivisionsY?: number[];
    levelCount?: number;
    lineColor?: [number, number, number, number];
    lineWidthPx?: number;
    debugSolid?: number;
    gridMode?: number;
}

interface TileStateShaderModuleProps {
    localMin?: [number, number];
    localSize?: [number, number];
    gridMode?: number;
    textureSize?: [number, number];
    tileStateTexture?: Texture;
}

function clamp(value: number, minValue: number, maxValue: number): number {
    return Math.max(minValue, Math.min(maxValue, value));
}

function packSubdivisions(values: number[], offset: number): [number, number, number, number] {
    return [
        Math.max(1, values[offset] ?? 1),
        Math.max(1, values[offset + 1] ?? 1),
        Math.max(1, values[offset + 2] ?? 1),
        Math.max(1, values[offset + 3] ?? 1)
    ];
}

const TILE_GRID_COMMON_VERTEX_DECL = `const float TILE_GRID_WORLD_SIZE = 512.0;
in vec3 tileGridNdsCorrectionCoefficients;
out vec2 tileGridLocal01;
out vec3 tileGridNdsCorrection;`;

function tileGridCommonVertexFilter(uniformName: string): string {
    return `vec2 projectedCoords = (geometry.position.xy + project.commonOrigin.xy) / TILE_GRID_WORLD_SIZE;
if (${uniformName}.gridMode > 0.5) {
    vec2 normalizedCoords = vec2(
        projectedCoords.x,
        clamp((90.0 - geometry.worldPosition.y) / 180.0, 0.0, 1.0)
    );
    tileGridLocal01 = (normalizedCoords - ${uniformName}.localMin) / ${uniformName}.localSize;
} else {
    tileGridLocal01 = (projectedCoords - ${uniformName}.localMin) / ${uniformName}.localSize;
}
tileGridNdsCorrection = tileGridNdsCorrectionCoefficients;`;
}

function tileGridCommonFragmentDecl(uniformName: string): string {
    return `in vec2 tileGridLocal01;
in vec3 tileGridNdsCorrection;

vec2 tile_grid_local_coords() {
    vec2 localCoords = tileGridLocal01;
    if (${uniformName}.gridMode > 0.5) {
        float localY = clamp(localCoords.y, 0.0, 1.0);
        localCoords.y = clamp(
            tileGridNdsCorrection.x
                + tileGridNdsCorrection.y * localY
                + tileGridNdsCorrection.z * localY * localY,
            0.0,
            1.0
        );
    }
    return localCoords;
}`;
}

const tileGridOverlayShaderModule: ShaderModule = {
    name: "tileGridOverlay",
    vs: `\
uniform tileGridOverlayUniforms {
  vec2 localMin;
  vec2 localSize;
  vec4 subdivisionsX0;
  vec4 subdivisionsX1;
  vec4 subdivisionsX2;
  vec4 subdivisionsX3;
  vec4 subdivisionsY0;
  vec4 subdivisionsY1;
  vec4 subdivisionsY2;
  vec4 subdivisionsY3;
  vec4 lineColor;
  float levelCount;
  float lineWidthPx;
  float debugSolid;
  float gridMode;
} tileGridOverlay;
`,
    fs: `\
uniform tileGridOverlayUniforms {
  vec2 localMin;
  vec2 localSize;
  vec4 subdivisionsX0;
  vec4 subdivisionsX1;
  vec4 subdivisionsX2;
  vec4 subdivisionsX3;
  vec4 subdivisionsY0;
  vec4 subdivisionsY1;
  vec4 subdivisionsY2;
  vec4 subdivisionsY3;
  vec4 lineColor;
  float levelCount;
  float lineWidthPx;
  float debugSolid;
  float gridMode;
} tileGridOverlay;
`,
    uniformTypes: {
        localMin: "vec2<f32>",
        localSize: "vec2<f32>",
        subdivisionsX0: "vec4<f32>",
        subdivisionsX1: "vec4<f32>",
        subdivisionsX2: "vec4<f32>",
        subdivisionsX3: "vec4<f32>",
        subdivisionsY0: "vec4<f32>",
        subdivisionsY1: "vec4<f32>",
        subdivisionsY2: "vec4<f32>",
        subdivisionsY3: "vec4<f32>",
        lineColor: "vec4<f32>",
        levelCount: "f32",
        lineWidthPx: "f32",
        debugSolid: "f32",
        gridMode: "f32"
    },
    getUniforms: (opts?: TileGridShaderModuleProps) => {
        const localMin = opts?.localMin ?? [0, 0];
        const localSize = opts?.localSize ?? [1, 1];
        const subdivisionsX = opts?.subdivisionsX ?? [];
        const subdivisionsY = opts?.subdivisionsY ?? [];
        const levelCount = clamp(Math.floor(opts?.levelCount ?? 0), 0, TILE_GRID_MAX_LEVEL_COUNT);
        const lineColor = opts?.lineColor ?? [1, 1, 1, 1];
        const lineWidthPx = opts?.lineWidthPx ?? 1.0;
        return {
            localMin: [
                Number.isFinite(localMin[0]) ? localMin[0] : 0,
                Number.isFinite(localMin[1]) ? localMin[1] : 0
            ],
            localSize: [
                Math.max(1e-6, Number.isFinite(localSize[0]) ? localSize[0] : 1),
                Math.max(1e-6, Number.isFinite(localSize[1]) ? localSize[1] : 1)
            ],
            subdivisionsX0: packSubdivisions(subdivisionsX, 0),
            subdivisionsX1: packSubdivisions(subdivisionsX, 4),
            subdivisionsX2: packSubdivisions(subdivisionsX, 8),
            subdivisionsX3: packSubdivisions(subdivisionsX, 12),
            subdivisionsY0: packSubdivisions(subdivisionsY, 0),
            subdivisionsY1: packSubdivisions(subdivisionsY, 4),
            subdivisionsY2: packSubdivisions(subdivisionsY, 8),
            subdivisionsY3: packSubdivisions(subdivisionsY, 12),
            lineColor: [
                clamp(lineColor[0], 0, 1),
                clamp(lineColor[1], 0, 1),
                clamp(lineColor[2], 0, 1),
                clamp(lineColor[3], 0, 1)
            ],
            levelCount,
            lineWidthPx: Math.max(0.5, lineWidthPx),
            debugSolid: opts?.debugSolid ?? 0,
            gridMode: opts?.gridMode ?? 0
        };
    }
};

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

function tileGridDatumCorrection(datum: TileGridOverlayDatum): [number, number, number] {
    return datum.ndsYCorrection ?? TILE_GRID_IDENTITY_CORRECTION;
}

function addTileGridCorrectionAttribute(layer: SolidPolygonLayer<TileGridOverlayDatum, any>): void {
    layer.getAttributeManager()?.add({
        tileGridNdsCorrectionCoefficients: {
            size: 3,
            stepMode: "dynamic",
            accessor: (datum: TileGridOverlayDatum) => tileGridDatumCorrection(datum)
        }
    });
}

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

export interface TileGridOverlayDatum {
    polygon: [number, number][];
    ndsYCorrection?: [number, number, number];
}

export interface TileGridOverlayLayerProps extends SolidPolygonLayerProps<TileGridOverlayDatum> {
    levels: number[];
    gridMode: "xyz" | "nds";
    localMin: [number, number];
    localSize: [number, number];
    subdivisionsX: number[];
    subdivisionsY: number[];
    lineColor: [number, number, number, number];
    lineWidthPixels: number;
    debugSolid: boolean;
}

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
 * The per-datum NDS correction allows different latitude bands to carry their
 * own local approximation while still sharing one logical layer.
 */
export class TileGridOverlayLayer extends SolidPolygonLayer<TileGridOverlayDatum, TileGridOverlayLayerProps> {
    static override layerName = "TileGridOverlayLayer";

    override initializeState(): void {
        super.initializeState();
        addTileGridCorrectionAttribute(this);
    }

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
${tileGridCommonVertexFilter("tileGridOverlay")}`,
                "fs:#decl": `${existingDecl}
${tileGridCommonFragmentDecl("tileGridOverlay")}

float tile_grid_subdiv_x(int levelIndex) {
    if (levelIndex < 4) return tileGridOverlay.subdivisionsX0[levelIndex];
    if (levelIndex < 8) return tileGridOverlay.subdivisionsX1[levelIndex - 4];
    if (levelIndex < 12) return tileGridOverlay.subdivisionsX2[levelIndex - 8];
    return tileGridOverlay.subdivisionsX3[levelIndex - 12];
}

float tile_grid_subdiv_y(int levelIndex) {
    if (levelIndex < 4) return tileGridOverlay.subdivisionsY0[levelIndex];
    if (levelIndex < 8) return tileGridOverlay.subdivisionsY1[levelIndex - 4];
    if (levelIndex < 12) return tileGridOverlay.subdivisionsY2[levelIndex - 8];
    return tileGridOverlay.subdivisionsY3[levelIndex - 12];
}

float tile_grid_line_mask_for_level(int levelIndex, vec2 localCoords) {
    vec2 tileCoords = localCoords * vec2(
        tile_grid_subdiv_x(levelIndex),
        tile_grid_subdiv_y(levelIndex)
    );
    vec2 edge = min(fract(tileCoords), 1.0 - fract(tileCoords));
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
    return max(verticalMask, horizontalMask);
}`,
                "fs:DECKGL_FILTER_COLOR": `${existingFilter}
if (tileGridOverlay.levelCount <= 0.5) {
    color = vec4(0.0);
} else if (tileGridOverlay.debugSolid > 0.5) {
    color = vec4(1.0, 0.1, 0.1, 0.65);
} else {
    vec2 tileGridLocal01 = tile_grid_local_coords();
    float mask = 0.0;
    for (int i = 0; i < ${TILE_GRID_MAX_LEVEL_COUNT}; i++) {
        if (float(i) >= tileGridOverlay.levelCount) {
            break;
        }
        mask = max(mask, tile_grid_line_mask_for_level(i, tileGridLocal01));
    }
    color = vec4(
        tileGridOverlay.lineColor.rgb,
        tileGridOverlay.lineColor.a * mask * layer.opacity
    );
}`
            }
        };
    }

    override draw(params: any): void {
        const levelCount = Math.min(
            TILE_GRID_MAX_LEVEL_COUNT,
            this.normalizedLevels().length,
            this.props.subdivisionsX.length,
            this.props.subdivisionsY.length
        );
        const lineColor = this.props.lineColor ?? [255, 255, 255, 255];
        this.setShaderModuleProps({
            tileGridOverlay: {
                localMin: this.props.localMin,
                localSize: this.props.localSize,
                subdivisionsX: this.props.subdivisionsX,
                subdivisionsY: this.props.subdivisionsY,
                levelCount,
                lineColor: [
                    lineColor[0] / 255,
                    lineColor[1] / 255,
                    lineColor[2] / 255,
                    lineColor[3] / 255
                ],
                lineWidthPx: this.props.lineWidthPixels,
                debugSolid: this.props.debugSolid ? 1 : 0,
                gridMode: this.props.gridMode === "nds" ? 1 : 0
            } satisfies TileGridShaderModuleProps
        });
        super.draw(params);
    }

    private normalizedLevels(): number[] {
        const levels: number[] = [];
        for (const rawLevel of this.props.levels ?? []) {
            if (levels.length >= TILE_GRID_MAX_LEVEL_COUNT) {
                break;
            }
            if (!Number.isFinite(rawLevel)) {
                continue;
            }
            levels.push(
                Math.max(
                    TILE_GRID_MIN_LEVEL,
                    Math.min(TILE_GRID_MAX_LEVEL, Math.floor(rawLevel))
                )
            );
        }
        return levels;
    }
}

/**
 * Shader-backed tile-state overlay that samples the cell colors from a raster
 * texture while using the exact same NDS remap as the grid lines.
 */
export class TileGridStateOverlayLayer extends SolidPolygonLayer<TileGridOverlayDatum, TileGridStateOverlayLayerProps> {
    static override layerName = "TileGridStateOverlayLayer";

    declare state: SolidPolygonLayer<TileGridOverlayDatum, TileGridStateOverlayLayerProps>["state"] & TileGridStateOverlayLayerState;

    override initializeState(): void {
        super.initializeState();
        addTileGridCorrectionAttribute(this);
        this.state.tileStateTexture = createTileStateTexture(this.context.device, null);
    }

    override updateState(params: any): void {
        super.updateState(params);
        if (params.props.imageData === params.oldProps.imageData) {
            return;
        }
        this.state.tileStateTexture?.delete();
        this.state.tileStateTexture = createTileStateTexture(this.context.device, params.props.imageData);
    }

    override finalizeState(context: any): void {
        this.state.tileStateTexture?.delete();
        super.finalizeState(context);
    }

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
${tileGridCommonVertexFilter("tileGridStateOverlay")}`,
                "fs:#decl": `${existingDecl}
${tileGridCommonFragmentDecl("tileGridStateOverlay")}

vec4 tile_grid_state_color(vec2 localCoords) {
    vec2 clampedCoords = clamp(localCoords, vec2(0.0), vec2(1.0));
    vec2 texelIndex = floor(clampedCoords * tileGridStateOverlay.textureSize);
    texelIndex = min(texelIndex, tileGridStateOverlay.textureSize - 1.0);
    vec2 uv = (texelIndex + 0.5) / tileGridStateOverlay.textureSize;
    return texture(tileGridStateOverlayTexture, uv);
}`,
                "fs:DECKGL_FILTER_COLOR": `${existingFilter}
vec4 stateColor = tile_grid_state_color(tile_grid_local_coords());
color = vec4(stateColor.rgb, stateColor.a * layer.opacity);`
            }
        };
    }

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

export function tileGridOverlayData(): TileGridOverlayDatum[] {
    return [{polygon: TILE_GRID_WORLD_RING, ndsYCorrection: TILE_GRID_IDENTITY_CORRECTION}];
}
