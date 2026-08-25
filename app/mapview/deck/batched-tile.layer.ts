import {TileLayer} from "../../integrations/deckgl";

const TILE_UPDATE_QUIET_MS = 100;
const TILE_UPDATE_MAX_LATENCY_MS = 1_000;

type LoadedTile<DataT> = Parameters<TileLayer<DataT>["_onTileLoad"]>[0];

/**
 * Coalesces raster tile completions before asking Deck to rebuild sublayers.
 *
 * An ordinary TileLayer invalidates the whole Deck frame for every image that
 * arrives. Erdblick's vector scene is intentionally shared and expensive, so
 * hundreds of independent OSM completions would otherwise redraw it hundreds
 * of times even though only the background changed.
 */
export class BatchedTileLayer<DataT = unknown> extends TileLayer<DataT> {
    static override layerName = "BatchedTileLayer";

    private updateTimer: ReturnType<typeof setTimeout> | null = null;
    private updateBurstStartedAtMs = 0;

    /** Retain loaded content immediately but defer one shared sublayer rebuild. */
    override _onTileLoad(tile: LoadedTile<DataT>): void {
        this.props.onTileLoad(tile);
        tile.layers = null;
        this.scheduleTileUpdate();
    }

    /** Treat failed tiles like completed ones so neighboring imagery can appear together. */
    override _onTileError(error: unknown, tile: LoadedTile<DataT>): void {
        this.props.onTileError(error);
        tile.layers = null;
        this.scheduleTileUpdate();
    }

    /** Cancel delayed work before the background or Deck context disappears. */
    override finalizeState(): void {
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }
        this.updateBurstStartedAtMs = 0;
        super.finalizeState();
    }

    /** Debounce fast arrivals while guaranteeing progress for a continuous stream. */
    private scheduleTileUpdate(): void {
        const now = performance.now();
        if (this.updateBurstStartedAtMs === 0) {
            this.updateBurstStartedAtMs = now;
        }
        const dueAt = Math.min(
            now + TILE_UPDATE_QUIET_MS,
            this.updateBurstStartedAtMs + TILE_UPDATE_MAX_LATENCY_MS
        );
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
        }
        this.updateTimer = setTimeout(() => {
            this.updateTimer = null;
            this.updateBurstStartedAtMs = 0;
            this.setNeedsUpdate();
        }, Math.max(0, dueAt - now));
    }
}
