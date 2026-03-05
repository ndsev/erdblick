import {SolidPolygonLayer, SolidPolygonLayerProps} from "@deck.gl/layers";
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
            lineWidthPx: Math.max(0.5, Number.isFinite(opts?.lineWidthPx) ? opts!.lineWidthPx! : 1.0),
            debugSolid: opts?.debugSolid ?? 0,
            gridMode: opts?.gridMode ?? 0
        };
    }
};

export interface TileGridOverlayDatum {
    polygon: [number, number][];
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

/**
 * Single-layer screen-space tile grid overlay rendered by shader evaluation.
 * This avoids per-tile deck layer churn for border visualization.
 */
export class TileGridOverlayLayer extends SolidPolygonLayer<TileGridOverlayDatum, TileGridOverlayLayerProps> {
    static override layerName = "TileGridOverlayLayer";

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
out vec2 tileGridLocal01;`,
                "vs:DECKGL_FILTER_COLOR": `${existingVsFilter}
if (tileGridOverlay.gridMode > 0.5) {
    vec2 normalizedCoords = vec2(
        fract((geometry.worldPosition.x + 180.0) / 360.0),
        clamp((90.0 - geometry.worldPosition.y) / 180.0, 0.0, 1.0)
    );
    tileGridLocal01 = (normalizedCoords - tileGridOverlay.localMin) / tileGridOverlay.localSize;
} else {
    vec2 normalizedCoords = (geometry.position.xy + project.commonOrigin.xy) / 512.0;
    tileGridLocal01 = (normalizedCoords - tileGridOverlay.localMin) / tileGridOverlay.localSize;
}`,
                "fs:#decl": `${existingDecl}
in vec2 tileGridLocal01;

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
    float verticalMask = 1.0 - smoothstep(halfWidthPx, halfWidthPx, distPxToVertical);
    float horizontalMask = 1.0 - smoothstep(halfWidthPx, halfWidthPx, distPxToHorizontal);
    return max(verticalMask, horizontalMask);
}`,
                "fs:DECKGL_FILTER_COLOR": `${existingFilter}
if (tileGridOverlay.levelCount <= 0.5) {
    color = vec4(0.0);
} else if (tileGridOverlay.debugSolid > 0.5) {
    color = vec4(1.0, 0.1, 0.1, 0.65);
} else {
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

export function tileGridOverlayData(): TileGridOverlayDatum[] {
    return [{polygon: TILE_GRID_WORLD_RING}];
}
