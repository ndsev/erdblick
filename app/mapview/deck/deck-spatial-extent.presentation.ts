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

/** Native queries distinguish a cheap hit identity from geometry requested by navigation. */
export interface SpatialExtentQueries {
    rectangles: (layer: SpatialExtentLayer, viewport: Viewport) => SpatialExtentBounds[];
    tileAt: (longitude: number, latitude: number, level: number) => number;
    region: (layer: SpatialExtentLayer, tile: number) => number;
    bounds: (layer: SpatialExtentLayer, region: number) => SpatialExtentBounds[];
}

/** Own compact coverage quads and their shader grid, independently of payload demand or tile capacity. */
export class DeckSpatialExtentOverlay {
    private keys = new Set<string>();
    private pending: number | null = null;
    private frame: SpatialExtentFrame | null = null;
    private signature = "";
    private destroyed = false;
    private readonly hits = new Map<string, {layer: SpatialExtentLayer; tile: number; region: number}>();

    /** Narrow native callbacks retain all spatial interpretation in the shared evaluator. */
    constructor(private readonly registry: DeckLayerRegistry,
        private readonly readFrame: () => SpatialExtentFrame | null,
        private readonly queries: SpatialExtentQueries) {}

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
        const layers = new Map((frame?.layers ?? []).map(layer => [JSON.stringify([layer.mapId, layer.layerId]), layer]));
        for (const [key, hit] of this.hits) {
            const layer = layers.get(key);
            if (!layer || layer.level !== hit.layer.level || layer.revision !== hit.layer.revision) this.hits.delete(key);
        }
        const groups = new Map<string, {level: number; rectangles: SpatialExtentBounds[]}>();
        for (const layer of frame?.layers ?? []) {
            const key = `builtin/spatial-extent/${encodeURIComponent(layer.mapId)}/${layer.level}`;
            const group = groups.get(key) ?? {level: layer.level, rectangles: []};
            for (const rectangle of this.queries.rectangles(layer, frame!.viewport)) group.rectangles.push(rectangle);
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
        const hit = this.pick(longitude, latitude);
        return hit ? spatialExtentEnvelope(this.queries.bounds(hit.layer, hit.region)) : null;
    }

    /** A lightweight label follows the same stable hit order as click navigation. */
    label(longitude: number, latitude: number): string | null {
        const hit = this.pick(longitude, latitude);
        return hit ? `${hit.layer.mapId} · Spatial extent · Level ${hit.layer.level}` : null;
    }

    /** Resolve a tile to its originating extent without involving feature picking. */
    private pick(longitude: number, latitude: number) {
        const layers = this.frame?.layers ?? [];
        for (let index = layers.length - 1; index >= 0; --index) {
            const layer = layers[index];
            const key = JSON.stringify([layer.mapId, layer.layerId]);
            const tile = this.queries.tileAt(longitude, latitude, layer.level);
            let hit = this.hits.get(key);
            if (!hit || hit.tile !== tile || hit.layer.level !== layer.level || hit.layer.revision !== layer.revision) {
                hit = {layer, tile, region: this.queries.region(layer, tile)};
                this.hits.set(key, hit);
            }
            if (hit.region >= 0) return hit;
        }
        return null;
    }

    /** Fence removed metadata immediately, including before the next coalesced overlay frame. */
    invalidateMaps(mapIds: readonly string[]): void {
        const removed = new Set(mapIds);
        for (const [key, hit] of this.hits) if (removed.has(hit.layer.mapId)) this.hits.delete(key);
        if (this.frame) this.frame = {...this.frame, layers: this.frame.layers.filter(layer => !removed.has(layer.mapId))};
        this.signature = "";
        this.scheduleUpdate();
    }

    /** Remove presentation and cancel pending callbacks before the canvas retires. */
    destroy(): void {
        this.destroyed = true;
        if (this.pending !== null) cancelAnimationFrame(this.pending);
        for (const key of this.keys) this.registry.remove(key);
        this.keys.clear(); this.hits.clear(); this.frame = null;
    }
}
