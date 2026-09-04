import "@angular/compiler";
import {describe, expect, it} from "vitest";
import {TileGridOverlayLayer} from "./deck-tile-grid-overlay.layer";

describe("TileGridOverlayLayer", () => {
    it("derives NDS coordinates per fragment from continuous projected coordinates", () => {
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
        const fragmentDeclaration = shaders.inject["fs:#decl"] as string;

        expect(vertexDeclaration).toContain("out vec2 tileGridProjected01");
        expect(vertexDeclaration).not.toContain("tileGridNdsCorrection");
        expect(fragmentDeclaration).toContain("tile_grid_mercator_to_nds_y");
        expect(fragmentDeclaration).toContain("exp(mercatorN) - exp(-mercatorN)");
    });
});
