import {Viewport} from "../../build/libs/core/erdblick-core";
import {coreLib} from "../integrations/wasm";
import type {TileVisualization} from "./tile.visualization.model";

export const DEFAULT_VIEWPORT: Viewport = {
    south: .0,
    west: .0,
    width: .0,
    height: .0,
    camPosLon: .0,
    camPosLat: .0,
    orientation: .0
};

export class ViewVisualizationState {
    viewport: Viewport = DEFAULT_VIEWPORT;
    visibleTileIds: Set<bigint> = new Set();
    visibleTileIdsPerLevel = new Map<number, Array<bigint>>();
    highDetailTileIds: Set<bigint> = new Set();
    visualizationQueue: TileVisualization[] = [];
    private visualizedTileLayers: Map<string, Map<string, TileVisualization>> = new Map();

    getVisualization(styleId: string, tileKey: string): TileVisualization | undefined {
        return this.visualizedTileLayers.get(styleId)?.get(tileKey);
    }

    putVisualization(styleId: string, tileKey: string, visu: TileVisualization) {
        let tileVisus = this.visualizedTileLayers.get(styleId);
        if (!tileVisus) {
            tileVisus = new Map<string, TileVisualization>();
            this.visualizedTileLayers.set(styleId, tileVisus);
        }
        tileVisus.set(tileKey, visu);
    }

    hasVisualizations(styleId: string): boolean {
        return this.visualizedTileLayers.has(styleId);
    }

    *removeVisualizations(styleId?: string, tileKey?: string): Generator<TileVisualization> {
        if (styleId !== undefined) {
            if (tileKey !== undefined) {
                const tileVisus = this.visualizedTileLayers.get(styleId);
                if (!tileVisus) {
                    return;
                }
                const visu = tileVisus.get(tileKey);
                if (visu) {
                    yield visu;
                    tileVisus.delete(tileKey);
                }
                if (!tileVisus.size) {
                    this.visualizedTileLayers.delete(styleId);
                }
                return;
            }
            const tileVisus = this.visualizedTileLayers.get(styleId);
            if (tileVisus) {
                for (const visu of tileVisus.values()) {
                    yield visu;
                }
            }
            this.visualizedTileLayers.delete(styleId);
            return;
        }

        if (tileKey !== undefined) {
            const stylesToDelete: string[] = [];
            for (const [style, tileVisus] of this.visualizedTileLayers) {
                const visu = tileVisus.get(tileKey);
                if (visu) {
                    yield visu;
                    tileVisus.delete(tileKey);
                }
                if (!tileVisus.size) {
                    stylesToDelete.push(style);
                }
            }
            for (const style of stylesToDelete) {
                this.visualizedTileLayers.delete(style);
            }
            return;
        }

        for (const tileVisus of this.visualizedTileLayers.values()) {
            for (const visu of tileVisus.values()) {
                yield visu;
            }
        }
        this.visualizedTileLayers.clear();
    }

    *getVisualizedStyleIds(): Generator<string> {
        for (const styleId of Array.from(this.visualizedTileLayers.keys())) {
            yield styleId;
        }
    }

    *getVisualizations(styleId?: string, tileKey?: string): Generator<TileVisualization> {
        if (styleId !== undefined) {
            const tileVisus = this.visualizedTileLayers.get(styleId);
            if (!tileVisus) {
                return;
            }
            if (tileKey !== undefined) {
                const visu = tileVisus.get(tileKey);
                if (visu) {
                    yield visu;
                }
                return;
            }
            for (const visu of tileVisus.values()) {
                yield visu;
            }
            return;
        }

        if (tileKey !== undefined) {
            for (const tileVisus of this.visualizedTileLayers.values()) {
                const visu = tileVisus.get(tileKey);
                if (visu) {
                    yield visu;
                }
            }
            return;
        }

        for (const tileVisus of this.visualizedTileLayers.values()) {
            for (const visu of tileVisus.values()) {
                yield visu;
            }
        }
    }

    recalculateTileIds(loadLimit: number, visualizeLimit: number, levels: Iterable<number>) {
        this.visibleTileIds.clear();
        this.highDetailTileIds.clear();
        this.visibleTileIdsPerLevel.clear();
        for (let level of levels) {
            if (this.visibleTileIdsPerLevel.has(level)) {
                continue;
            }
            const visibleTileIdsForLevel = coreLib.getTileIds(this.viewport, level, loadLimit) as bigint[];
            this.visibleTileIdsPerLevel.set(level, visibleTileIdsForLevel);
            this.visibleTileIds = new Set([
                ...this.visibleTileIds,
                ...new Set<bigint>(visibleTileIdsForLevel)
            ]);
            this.highDetailTileIds = new Set([
                ...this.highDetailTileIds,
                ...new Set<bigint>(visibleTileIdsForLevel.slice(0, visualizeLimit))
            ]);
        }
    }
}
