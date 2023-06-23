"use strict";

import {
    Vector2,
    Vector3,
    Matrix4,
    Sphere,
    Box3
} from "../deps/three.js";
import {MapViewerConst} from "./consts.js";
import {align, scenePosFromWgs84} from "./utils.js";

export class MapViewerViewportTile {
    constructor(subtileCols, subtileRows) {
        /** @member {number} subtileCols - Number of horizontal subtile divisons. */
        this.subtileCols = subtileCols;
        /** @member {number} subtileRows - Number of vertical subtile divisons. */
        this.subtileRows = subtileRows;
        /** @member {[(MapViewerViewportSubTile|null)]} offset - 16 array entries for 4*4 subtiles. */
        this.subtiles = null;
        /** @member {number} phiStart - Start of the horizontal angular extent */
        this.phiStart = 0;
        /** @member {number} phiEnd - End of the horizontal angular extent */
        this.phiEnd = 0;
        /** @member {number} phiLength - Length of the horizontal angular extent */
        this.phiLength = 0;
        /** @member {number} thetaStart - Start of the vertical angular extent */
        this.thetaStart = 0;
        /** @member {number} thetaEnd - End of the vertical angular extent */
        this.thetaEnd = 0;
        /** @member {number} thetaLength - Length of the vertical angular extent */
        this.thetaLength = 0;
        /** @member {boolean} required - Used to filter tiles which are not part of `the nine` anymore. */
        this.required = true;
        /** @member {[number,number]} offset - Offset of the tile from center tile. */
        this.offset = [0, 0];
    }

    /**
     * Notify the tile (and it's subtiles) about their spherical extent
     * @param {number} phiStart
     * @param {number} phiEnd
     * @param {number} thetaStart
     * @param {number} thetaEnd
     */
    updateExtent(phiStart, phiEnd, thetaStart, thetaEnd)
    {
        this.phiStart = phiStart;
        this.phiEnd = phiEnd;
        this.phiLength = phiEnd - phiStart;
        this.thetaStart = thetaStart;
        this.thetaEnd = thetaEnd;
        this.thetaLength = thetaEnd - thetaStart;

        if (!this.subtiles) {
            this.subtiles = [...Array(this.subtileCols * this.subtileRows)]
                .map((_, i) => {
                    let col = i % this.subtileCols;
                    let row = Math.floor(i / this.subtileCols);

                    let size = new Vector2((phiEnd - phiStart)/this.subtileCols,
                        (thetaEnd - thetaStart)/this.subtileRows);
                    let offset = new Vector2(phiStart + col * size.x,
                        thetaStart + row * size.y);

                    return new MapViewerViewportSubTile(offset, size, col, row);
                });
        }
        this.subtiles.forEach((tile) => {
            tile.angularOffset.set(
                phiStart + tile.col * tile.angularSize.x,
                thetaStart + tile.row * tile.angularSize.y);
        });
    }
}

export class MapViewerViewportSubTile {
    /**
     * Construct a viewport subtile from globe angular offset and size.
     * @param {Vector2} angularOffset
     * @param {Vector2} angularSize
     * @param {number} col
     * @param {number} row
     */
    constructor(angularOffset, angularSize, col, row) {
        this.renderTileId = null;
        this.angularOffset = angularOffset;
        this.angularSize = angularSize;
        this.col = col;
        this.row = row;

        let polarToEuclidian = (x, y) => {
            let defaultPosition = new Vector3(0., MapViewerConst.globeRenderRadius, 0.);

            let vCos = new Vector2(Math.cos(x), Math.cos(y));
            let vSin = new Vector2(Math.sin(x), Math.sin(y));
            let polarToEuclidian = new Matrix4().set(
                vCos.x,   vSin.x * vSin.y,  vSin.x * vCos.y, 0.,
                0.,       vCos.y,          -vSin.y,          0.,
                -vSin.x,  vCos.x * vSin.y,  vCos.x * vCos.y, 0.,
                0.,       0.,               0.,              1.);

            return defaultPosition.applyMatrix4(polarToEuclidian);
        };

        this.boundingSphere = new Sphere().setFromPoints([
            polarToEuclidian(angularOffset.x, angularOffset.y),
            polarToEuclidian(angularOffset.x, angularOffset.y + angularSize.y),
            polarToEuclidian(angularOffset.x + angularSize.x, angularOffset.y),
            polarToEuclidian(angularOffset.x + angularSize.x, angularOffset.y + angularSize.y),
        ]);
        this.culled = false;
        this.penalty = -1;
    }

    /**
     * @param sphere {Sphere}
     * @return {boolean}
     */
    intersectsWith(sphere) {
        return sphere.intersectsSphere(this.boundingSphere);
    }

    /**
     * @param {Vector3} camPos - Camera World Position
     * @return {number} - New penalty value
     */
    updatePenalty(camPos) {
        if (this.culled)
            return this.penalty = Infinity;
        return this.penalty = camPos.distanceTo(this.boundingSphere.center);
    }
}

/**
 This structure is used to feed input to the Globe::update method.
 Therefore, it's coordinates are in [-PI,PI],[0,PI] domain,
 NOT standard Wgs84 [-PI,PI],[PI/2,-PI/2] as in other places in this class.

 It is calculated by
*/
export class MapViewerViewport
{
    constructor()
    {
        this.outer = {
            phiStart: -Math.PI,
            phiEnd: Math.PI,
            phiLength: 2*Math.PI,
            thetaStart: 0,
            thetaEnd: Math.PI,
            thetaLength: Math.PI,
        };
        /** @member {Object.<string,MapViewerViewportTile>} tiles - Points from `lv-i-j` string to tile object.*/
        this.tiles = {};
        this.lonTileLevel = null;
        this.latTileLevel = null;
        this.centerX = null;
        this.centerY = null;
        this.cameraViewRadius = 0;
        this.cameraPos = new Vector2();
        this.renderTileController = new MapViewerRenderTileController();
        this.numColumnsPerVpTile = 4;
        this.numRowsPerVpTile = 4;
    }

    clone() {
        let result = new MapViewerViewport();
        result.outer = {...this.outer};
        result.tiles = Object.keys(this.tiles).reduce((acc, key) => {
            acc[key] = {...this.tiles[key]};
            return acc
        }, {});
        result.lonTileLevel = this.lonTileLevel;
        result.latTileLevel = this.latTileLevel;
        result.centerX = this.centerX;
        result.centerY = this.centerY;
        result.cameraViewRadius = this.cameraViewRadius;
        result.cameraPos.copy(this.cameraPos.clone());
        return result;
    }

    /**
     * Updates the current viewport tiles and subtile<->rendertile associations.
     * @param {number} lon - Longitudinal position of camera on globe (surface root)
     * @param {number} lat - Latitudinal position of camera on globe (surface root)
     * @param {number} lonAngle - Rough estimate of horizontal angular view coverage.
     * @param {number} latAngle - Rough estimate of vertical angular view coverage.
     * @returns {boolean} - Did the viewport tiles change?
     */
    update(lon, lat, lonAngle, latAngle)
    {
        let scope = this;

        // -- 1) Calculate tile level
        let lonTileLevel = 0;
        let numTilesLon = 0;
        let tileSizeLon = 0;
        let centerX = 0;
        let centerPhiStart = 0;
        let centerPhiEnd = 0;
        let latTileLevel = 0;
        let numTilesLat = 0;
        let tileSizeLat = 0;
        let centerY = 0;
        let centerThetaStart = 0;
        let centerThetaEnd = 0;

        function setLonTileLv(lv) {
            lonTileLevel = lv;
            numTilesLon = 2 << lonTileLevel;
            tileSizeLon = Math.PI/(numTilesLon >> 1);
            centerX = (Math.floor(lon/tileSizeLon) % numTilesLon) + numTilesLon/2;  // Make sure the value is positive
            centerPhiStart = align(lon, tileSizeLon, false);
            centerPhiEnd = centerPhiStart + tileSizeLon;
        }
        function setLatTileLv(lv) {
            latTileLevel = lv;
            numTilesLat = 1 << latTileLevel;
            tileSizeLat = Math.PI/numTilesLat;
            centerY = Math.floor(lat/tileSizeLat) % numTilesLat;
            centerThetaStart = align(lat, tileSizeLat, false);
            centerThetaEnd = centerThetaStart + tileSizeLat;
        }
        setLonTileLv.call(scope, Math.floor(Math.log2(Math.PI / lonAngle)));
        setLatTileLv.call(scope, Math.floor(Math.log2(Math.PI / latAngle)));

        // -- 2) Precalculate tile id offsets
        const northPoleVisible = centerY < 1;
        const southPoleVisible = centerY >= (numTilesLat - 1);

        // Contains triples like [`xOff`, `yOff`, `hd`]
        // `hd` determines whether a tile will receive a single or double resolution texture.
        // If the `hd` value is null, it will be calculated based on whether the tile is in the
        // same viewport quadrant as the camera.
        let surroundingTileIdOffsets;

        if ((northPoleVisible && southPoleVisible) || lonTileLevel === 0 || latTileLevel === 0) {
            setLonTileLv.call(scope, 0);
            setLatTileLv.call(scope, 0);
            surroundingTileIdOffsets = [[0, 0, true], [1, 0, true]];
        }
        else if (northPoleVisible || southPoleVisible) {
            // 2x4 tiles
            setLonTileLv.call(scope, 1);
            const latOff = southPoleVisible ? -1 : 1;
            surroundingTileIdOffsets = [
                [0, 0, true], [1, 0, true], [2, 0, true], [3, 0, true],
                [0, latOff, false], [1, latOff, false], [2, latOff, false], [3, latOff, false],
            ]
        }
        else {
            // 3x3 tiles
            surroundingTileIdOffsets = [
                [-1, 1, null], [0, 1, null], [1, 1, null],
                [-1, 0, null], [0, 0, null], [1, 0, null],
                [-1, -1, null], [0, -1, null], [1, -1, null],
            ]
        }

        // -- 3) Determine whether vp actually changed
        let viewportChanged = (
            scope.centerX !== centerX ||
            scope.centerY !== centerY ||
            scope.lonTileLevel !== lonTileLevel ||
            scope.latTileLevel !== latTileLevel
        );
        if (viewportChanged)
        {
            // -- 4) Remember new vp params
            scope.centerX = centerX;
            scope.centerY = centerY;
            scope.outer.phiStart = centerPhiStart;
            scope.outer.phiEnd = centerPhiEnd;
            scope.outer.thetaStart = centerThetaStart;
            scope.outer.thetaEnd = centerThetaEnd;
            scope.lonTileLevel = lonTileLevel;
            scope.latTileLevel = latTileLevel;

            // -- 5) Mark all current viewport tiles as unneeded, preemptively
            scope.forEachTile((tile) => {tile.required = false;});

            // -- 6) Assemble needed tiles
            surroundingTileIdOffsets.forEach((offset) =>
            {
                let tileX = centerX + offset[0];
                let tileY = centerY + offset[1];
                if (tileX < 0)
                    tileX += numTilesLon;
                if (tileX >= numTilesLon)
                    tileX -= numTilesLon;
                let tileId = `(x: ${tileX}/${numTilesLon}, y: ${tileY}/${numTilesLat})`;

                let tile;
                if (scope.tiles[tileId] !== undefined) {
                    // Mark existing tile as required
                    tile = scope.tiles[tileId];
                    tile.required = true;
                }
                else {
                    // Create new required tile
                    scope.tiles[tileId] = tile = new MapViewerViewportTile(
                        scope.numColumnsPerVpTile,
                        scope.numRowsPerVpTile
                    );
                }

                // Always recalculate phiStart/phiEnd to be in the same frame of reference as center tile
                tile.updateExtent(
                    centerPhiStart + offset[0] * tileSizeLon,
                    centerPhiEnd + offset[0] * tileSizeLon,
                    centerThetaStart + offset[1] * tileSizeLat,
                    centerThetaEnd + offset[1] * tileSizeLat);
                tile.offset = offset;

                // Expand outer viewport extents according to added tile
                scope.outer.phiStart = Math.min(scope.outer.phiStart, tile.phiStart);
                scope.outer.phiEnd = Math.max(scope.outer.phiEnd, tile.phiEnd);
                scope.outer.thetaStart = Math.min(scope.outer.thetaStart, tile.thetaStart);
                scope.outer.thetaEnd = Math.max(scope.outer.thetaEnd, tile.thetaEnd);
            });
            scope.outer.phiLength = scope.outer.phiEnd - scope.outer.phiStart;
            scope.outer.thetaLength = scope.outer.thetaEnd - scope.outer.thetaStart;

            // -- 7) Filter required tiles
            let newTileCollection = {};
            Object.keys(scope.tiles).forEach((tileid) => {
                let tile = scope.tiles[tileid];
                if (tile.required) {
                    // Enter tile into the updated viewport tile map
                    newTileCollection[tileid] = tile;
                }
                else {
                    // Release subtiles
                    tile.subtiles.forEach((subtile) => {
                        if (subtile.renderTileId !== null)
                            scope.renderTileController.release(subtile.renderTileId);
                    });
                }
            });
            scope.tiles = newTileCollection;
        }

        // -- 8) Calculate camera view radius as viewport proportion
        scope.cameraPos = new Vector2(
            (lon - scope.outer.phiStart) / scope.outer.phiLength,
            (lat - scope.outer.thetaStart) / scope.outer.thetaLength);
        scope.cameraViewRadius = Math.min(
            scope.cameraPos.x, 1. - scope.cameraPos.x,
            scope.cameraPos.y, 1. - scope.cameraPos.y
        );

        return viewportChanged;
    }

    /**
     * @param {Box3} [angularExtents]
     */
    invalidate(angularExtents)
    {
        let scope = this;
        let boundingSphere = angularExtents ? new Sphere().setFromPoints(
            [scenePosFromWgs84(angularExtents.min.x, angularExtents.min.y, MapViewerConst.globeRenderRadius),
             scenePosFromWgs84(angularExtents.max.x, angularExtents.max.y, MapViewerConst.globeRenderRadius)]
        ) : null;

        scope.forEachTile((tile) => {
            tile.subtiles.forEach((subtile) => {
                if (subtile.renderTileId !== null && (!boundingSphere || subtile.intersectsWith(boundingSphere))) {
                    scope.renderTileController.invalidate(subtile.renderTileId);
                }
            });
        });
    }

    updateSubTiles(camPos, frustum)
    {
        let scope = this;
        let subtiles = [];
        scope.forEachTile((tile) => {
            tile.subtiles.forEach((subtile) => {
                subtile.culled = !frustum.intersectsSphere(subtile.boundingSphere);
                subtile.updatePenalty(camPos);
                subtiles.push(subtile);
            });
        });
        subtiles.sort((a, b) => {
            return a.penalty - b.penalty;
        });
        for (let i = subtiles.length-1; i >= 0; --i) {
            let subtile = subtiles[i];
            if (i >= scope.renderTileController.numRenderTiles || subtile.culled) {
                if (subtile.renderTileId !== null) {
                    scope.renderTileController.release(subtile.renderTileId);
                    subtile.renderTileId = null;
                }
            } else {
                if (subtile.renderTileId === null) {
                    subtile.renderTileId = scope.renderTileController.take(
                        subtile);
                }
            }
        }

        scope.publishSubTileStateDebugInfo();
    }

    publishSubTileStateDebugInfo() {
        let scope = this;

        if (scope.subtileStateFun !== undefined) {
            let info = [...Array(3 * scope.numRowsPerVpTile)].map(() => {
                return [...Array(3 * scope.numColumnsPerVpTile)].fill(" ⋅");
            });
            scope.forEachTile((tile) => {
                tile.subtiles.forEach((subtile) => {
                    let [x, y] = tile.offset;
                    info[(y + 1) * scope.numRowsPerVpTile + subtile.row]
                        [(x + 1) * scope.numColumnsPerVpTile + subtile.col] = (() => {
                        if (subtile.culled)
                            return " ⋅";
                        if (subtile.renderTileId !== null)
                            return " ■";
                        return " □"
                    })();
                });
            });

            let matrix = "";
            info.forEach((l) => {
                let line = "";
                l.forEach((c) => {
                    line += `${c}`;
                });
                if (line)
                    matrix += line + "<br>";
            });
            scope.subtileStateFun(matrix);
        }
    }

    equals(other) {
        const minAbsFloat = 1e-9;
        return (
            Math.abs(this.outer.phiStart - other.outer.phiStart) < minAbsFloat &&
            Math.abs(this.outer.phiLength - other.outer.phiLength) < minAbsFloat &&
            Math.abs(this.outer.thetaStart - other.outer.thetaStart) < minAbsFloat &&
            Math.abs(this.outer.thetaLength - other.outer.thetaLength) < minAbsFloat &&
            Object.keys(this.tiles).length === Object.keys(other.tiles).length);
    }

    forEachTile(tileFun) {
        Object.keys(this.tiles).forEach((tileid) => {
            let tile = this.tiles[tileid];
            tileFun(tile);
        });
    }

    wgs84() {
        return {
            swLon: this.outer.phiStart/Math.PI * 180.,
            swLat: (-this.outer.thetaEnd/Math.PI + .5) * 180.,
            sizeLon: this.outer.phiLength/Math.PI * 180.,
            sizeLat: this.outer.thetaLength/Math.PI * 180.
        }
    }

    setSubTileStateFun(subtileStateFun) {
        this.subtileStateFun = subtileStateFun;
    }

    gridAutoLevel() {
        return Math.min(Math.max(this.lonTileLevel, this.latTileLevel) + 3, 15);
    }
}

/*
The following is a list of possible values for the `state` field.
The state field is transitioned as follows:

    ... by MapViewerRenderTileController:
        UNUSED   → ASSIGNED // The tile is reassigned after it was cleared
        CLEARME  → ASSIGNED // The tile is reassigned before it was cleared
        *        → CLEARME  // The release function is called

    ... by MapViewerRenderingController
        ASSIGNED → DIRTY    // The tile was cleared, the uv matrix updated; it is ready for rendering
        DIRTY    → OK       // The tile was rendered, the content is up to date
        OK       → DIRTY    // Data was added or removed which affects the tile
        DIRTY    → DIRTY    // …
        CLEARME  → UNUSED   // The tile is cleared
*/
export const RenderTileState = {
    UNUSED: "unused",
    ASSIGNED: "assigned",
    DIRTY: "dirty",
    OK: "ok",
    CLEARME: "clearme"
};

export class MapViewerRenderTile
{
    constructor(id) {
        /** @member {(MapViewerViewportSubTile|null)} subtile */
        this.subtile = null;
        /** @member {string} state */
        this.state = RenderTileState.UNUSED;
        /** @member {number} id */
        this.id = id;
    }

    assigned(subtile) {
        console.assert(this.subtile === null && (this.state === RenderTileState.UNUSED || this.state === RenderTileState.CLEARME));
        this.subtile = subtile;
        this.state = RenderTileState.ASSIGNED;
    }

    dirty() {
        console.assert(
            this.state === RenderTileState.DIRTY ||
            this.state === RenderTileState.ASSIGNED ||
            this.state === RenderTileState.OK);
        this.state = RenderTileState.DIRTY;
    }

    rendered() {
        console.assert(this.state === RenderTileState.DIRTY);
        this.state = RenderTileState.OK;
    }

    clearme() {
        this.state = RenderTileState.CLEARME;
        this.subtile = null;
    }

    unused() {
        console.assert(this.state === RenderTileState.CLEARME);
        this.state = RenderTileState.UNUSED;
        this.subtile = null;
    }
}

export class MapViewerRenderTileController
{
    constructor() {
        /** @member {number} numRenderTiles */
        this.numRenderTiles = 32;
        /** @member {[MapViewerRenderTile]} numRenderTiles */
        this.tiles = [...Array(this.numRenderTiles)].map((_, id) => {
            return new MapViewerRenderTile(id);
        });
    }

    /** Returns next free render tile ID.
     *
     * @param {MapViewerViewportSubTile} subtile
     * @return {number|null} - Render tile id
     */
    take(subtile) {
        let tile = this.tiles.find((rendertile) => {
            return rendertile.state === RenderTileState.UNUSED || rendertile.state === RenderTileState.CLEARME;
        });
        if (!tile) {
            console.warn("A free tile was requested but there is none!");
            return null;
        }
        tile.assigned(subtile);
        return tile.id;
    }

    /**
     * Put a render tile ID back into the unused-pool
     *
     * @param {number} renderTileId
     */
    release(renderTileId) {
        console.assert(renderTileId >= 0 && renderTileId < this.tiles.length);
        this.tiles[renderTileId].clearme();
    }

    /**
     * Marks the rendertile as dirty
     *
     * @param {number} renderTileId
     */
    invalidate(renderTileId) {
        console.assert(renderTileId >= 0 && renderTileId < this.tiles.length);

        let tile = this.tiles[renderTileId];
        if (tile && tile.state !== RenderTileState.ASSIGNED)
            tile.dirty();
    }
}
