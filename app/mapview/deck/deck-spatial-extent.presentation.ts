import {COORDINATE_SYSTEM} from "@deck.gl/core";
import type {Viewport} from "../../../build/libs/core/erdblick-core";
import type {SpatialExtentBounds} from "../../mapdata/spatial-extent.model";
import type {RenderRectangle} from "../render-view.model";
import {spatialExtentEnvelope, unionSpatialTileRectangles} from "../spatial-extent-bounds.util";
import type {DeckLayerRegistry} from "./deck-layer-registry.util";
import {TileGridOverlayLayer, type TileGridOverlayDatum} from "./deck-tile-grid-overlay.layer";
import {DECK_OVERLAY_PARAMETERS} from "./deck-overlay.constants";

/** Effective enabled feature-layer coverage in a single view. */
export interface SpatialExtentLayer {mapId: string; layerId: string; level: number; revision: number;}
/** Immutable inputs used for one coalesced presentation update. */
export interface SpatialExtentFrame {viewport: Viewport; layers: SpatialExtentLayer[];}

/** Own compact coverage quads and their shader grid, independently of payload demand or tile capacity. */
export class DeckSpatialExtentOverlay {
    private keys = new Set<string>();
    private pending: number | null = null;
    private frame: SpatialExtentFrame | null = null;
    private signature = "";
    private destroyed = false;

    /** Narrow native callbacks retain all spatial interpretation in the shared evaluator. */
    constructor(private readonly registry: DeckLayerRegistry,
        private readonly readFrame: () => SpatialExtentFrame | null,
        private readonly rectangles: (layer: SpatialExtentLayer, viewport: Viewport) => SpatialExtentBounds[],
        private readonly clickedBounds: (layer: SpatialExtentLayer, longitude: number, latitude: number) => SpatialExtentBounds[]) {}

    /** Coalesce camera, catalog and settings updates within one animation frame. */
    scheduleUpdate(): void {
        if (this.destroyed || this.pending !== null) return;
        this.pending = requestAnimationFrame(() => {this.pending = null; this.update();});
    }

    /** Draw one union per map/level; all tile edges and crosshatching are evaluated by the shader. */
    private update(): void {
        const frame = this.readFrame();
        const signature = JSON.stringify(frame);
        if (signature === this.signature) return;
        this.signature = signature;
        this.frame = frame;
        const groups = new Map<string, {level: number; rectangles: SpatialExtentBounds[]}>();
        for (const layer of frame?.layers ?? []) {
            const key = `builtin/spatial-extent/${encodeURIComponent(layer.mapId)}/${layer.level}`;
            const group = groups.get(key) ?? {level: layer.level, rectangles: []};
            for (const rectangle of this.rectangles(layer, frame!.viewport)) group.rectangles.push(rectangle);
            groups.set(key, group);
        }
        for (const key of this.keys) if (!groups.has(key)) this.registry.remove(key);
        this.keys = new Set(groups.keys());
        for (const [key, group] of groups) {
            const data: TileGridOverlayDatum[] = [];
            for (const [west, south, east, north] of unionSpatialTileRectangles(group.rectangles)) {
                const bottom = Math.max(-85.0511287798066, south), top = Math.min(85.0511287798066, north);
                if (bottom >= top) continue;
                // Avoid a single edge wrapping the complete world through Deck's triangulation.
                for (let left = west; left < east; left += 180) {
                    const right = Math.min(left + 180, east);
                    data.push({polygon: [[left, bottom], [right, bottom], [right, top], [left, top]]});
                }
            }
            this.registry.upsert(key, new TileGridOverlayLayer({id: key, data,
                getPolygon: datum => datum.polygon, getFillColor: [255, 255, 255, 255],
                coordinateSystem: COORDINATE_SYSTEM.LNGLAT, pickable: false,
                gridMode: "nds", localMin: [0, 0], localSize: [1, 1],
                subdivisionX: 2 ** (group.level + 1), subdivisionY: 2 ** group.level,
                lineColor: [50, 132, 220, 210], lineWidthPixels: 1, hatchOpacity: 0.23,
                parameters: DECK_OVERLAY_PARAMETERS}), 510);
        }
    }

    /** Hit the displayed tile first, then return its complete original extent rather than the clipped quad. */
    hit(longitude: number, latitude: number): RenderRectangle | null {
        return this.pick(longitude, latitude)?.rectangle ?? null;
    }

    /** A lightweight label follows the same stable hit order as click navigation. */
    label(longitude: number, latitude: number): string | null {
        const hit = this.pick(longitude, latitude);
        return hit ? `${hit.layer.mapId} · Spatial extent · Level ${hit.layer.level}` : null;
    }

    /** Resolve a tile to its originating extent without involving feature picking. */
    private pick(longitude: number, latitude: number) {
        for (const layer of [...(this.frame?.layers ?? [])].reverse()) {
            const bounds = this.clickedBounds(layer, longitude, latitude);
            const rectangle = spatialExtentEnvelope(bounds);
            if (rectangle) return {layer, rectangle};
        }
        return null;
    }

    /** Remove presentation and cancel pending callbacks before the canvas retires. */
    destroy(): void {
        this.destroyed = true;
        if (this.pending !== null) cancelAnimationFrame(this.pending);
        for (const key of this.keys) this.registry.remove(key);
        this.keys.clear(); this.frame = null;
    }
}
