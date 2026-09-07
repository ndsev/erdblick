import "@angular/compiler";
import {describe, expect, it} from "vitest";
import {TileGridOverlayLayer} from "./deck-tile-grid-overlay.layer";

describe("TileGridOverlayLayer", () => {
    it("keeps high-zoom grid coordinates relative to Deck's projection origin", () => {
        const layer = new TileGridOverlayLayer({
            id: "tile-grid-shader-test",
            data: [],
            getPolygon: datum => datum.polygon,
            gridMode: "nds",
            localMin: [0, 0],
            localSize: [1, 1],
            subdivisionX: 2,
            subdivisionY: 1,
            lineColor: [255, 255, 255, 255],
            lineWidthPixels: 1
        });
        Object.defineProperty(layer, "context", {value: {defaultShaderModules: []}});

        const shaders = layer.getShaders("top");
        const vertexDeclaration = shaders.inject["vs:#decl"] as string;
        const vertexFilter = shaders.inject["vs:DECKGL_FILTER_COLOR"] as string;
        const fragmentDeclaration = shaders.inject["fs:#decl"] as string;

        expect(vertexDeclaration).toContain("out vec2 tileGridCommonOffset");
        expect(vertexDeclaration).not.toContain("tileGridNdsCorrection");
        expect(vertexFilter).toContain("tileGridCommonOffset = geometry.position.xy");
        expect(vertexFilter).toContain("PROJECTION_MODE_WEB_MERCATOR_AUTO_OFFSET");
        expect(fragmentDeclaration).toContain("tileGridUsesOffsetCoordinates > 0.5");
        expect(fragmentDeclaration).toContain("1.0 - tileGridProjected01.y");
        expect(fragmentDeclaration).toContain("tile_grid_latitude_delta");
        expect(fragmentDeclaration).toContain("tileGridOverlay.originTilePhase");
        expect(fragmentDeclaration).toContain("abs(tileCoords - round(tileCoords))");
        expect(fragmentDeclaration).toContain("tile_grid_mercator_to_nds_y");
        expect(fragmentDeclaration).toContain("exp(mercatorN) - exp(-mercatorN)");
    });
});
