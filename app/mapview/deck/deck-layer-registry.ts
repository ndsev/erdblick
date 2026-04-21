import type {Deck as DeckGlDeck} from "@deck.gl/core";

/** Minimal deck layer shape required by the registry. */
export interface DeckLayerLike {
    id: string;
}

export type DeckLike = Pick<DeckGlDeck<any>, "setProps">;

type ScheduleFn = (cb: () => void) => number;
type CancelFn = (handle: number) => void;

/** Default flush scheduler used in production: one RAF per pending registry update. */
function defaultSchedule(cb: () => void): number {
    return window.requestAnimationFrame(cb);
}

/** Cancels a scheduled registry flush created by `defaultSchedule`. */
function defaultCancel(handle: number): void {
    window.cancelAnimationFrame(handle);
}

interface LayerEntry {
    layer: DeckLayerLike;
    order: number;
}

export interface DeckLayerKeyParts {
    tileKey: string;
    styleId: string;
    hoverMode: string;
    kind: string;
    variant?: string;
}

/** Builds the stable layer key shared by all deck-backed visualizations. */
export function makeDeckLayerKey(parts: DeckLayerKeyParts): string {
    const baseKey = `${parts.tileKey}/${parts.styleId}/${parts.hoverMode}/${parts.kind}`;
    return parts.variant ? `${baseKey}/${parts.variant}` : baseKey;
}

/** Returns the common key prefix used to remove every deck layer that belongs to one tile. */
export function makeDeckLayerTilePrefix(tileKey: string): string {
    return `${tileKey}/`;
}

/**
 * Owns per-view deck layer composition and commits one merged array through deck.setProps().
 * Keys must be globally unique within a view.
 */
export class DeckLayerRegistry {
    private deck: DeckLike | null;
    private readonly entries = new Map<string, LayerEntry>();
    private readonly scheduleFn: ScheduleFn;
    private readonly cancelFn: CancelFn;
    private pendingFlushHandle: number | null = null;
    private dirty = false;

    /** Creates a registry that batches `deck.setProps({layers})` calls behind a scheduler. */
    constructor(
        deck: DeckLike | null = null,
        scheduleFn: ScheduleFn = defaultSchedule,
        cancelFn: CancelFn = defaultCancel
    ) {
        this.deck = deck;
        this.scheduleFn = scheduleFn;
        this.cancelFn = cancelFn;
    }

    /** Swaps the target deck instance and schedules a full layer-array flush. */
    setDeck(deck: DeckLike | null): void {
        this.deck = deck;
        this.scheduleFlush();
    }

    /** Inserts or replaces one keyed layer with an explicit ordering rank. */
    upsert(key: string, layer: DeckLayerLike, order = 0): void {
        this.entries.set(key, {layer, order});
        this.markDirty();
    }

    /** Removes one keyed layer and schedules a flush when something changed. */
    remove(key: string): boolean {
        const removed = this.entries.delete(key);
        if (removed) {
            this.markDirty();
        }
        return removed;
    }

    /** Removes every keyed layer below a prefix, typically for one tile or overlay family. */
    removeByPrefix(prefix: string): number {
        let removed = 0;
        for (const key of this.entries.keys()) {
            if (key.startsWith(prefix)) {
                this.entries.delete(key);
                removed++;
            }
        }
        if (removed > 0) {
            this.markDirty();
        }
        return removed;
    }

    /** Clears all layers currently tracked by the registry. */
    clear(): void {
        if (this.entries.size === 0) {
            return;
        }
        this.entries.clear();
        this.markDirty();
    }

    /** Commits the current ordered layer list to deck if the registry is dirty. */
    flush(): void {
        this.pendingFlushHandle = null;
        if (!this.dirty || !this.deck) {
            return;
        }

        const layers = [...this.entries.entries()]
            .sort((a, b) => {
                const orderDiff = a[1].order - b[1].order;
                if (orderDiff !== 0) {
                    return orderDiff;
                }
                return a[0].localeCompare(b[0]);
            })
            .map(([, entry]) => entry.layer);

        this.deck.setProps({layers: layers as never[]});
        this.dirty = false;
    }

    /** Returns the number of keyed layers currently tracked. */
    get size(): number {
        return this.entries.size;
    }

    /** Marks the registry dirty and ensures a future flush is scheduled exactly once. */
    private markDirty(): void {
        this.dirty = true;
        this.scheduleFlush();
    }

    /** Schedules a single future flush if one is not already pending. */
    private scheduleFlush(): void {
        if (this.pendingFlushHandle !== null) {
            return;
        }
        this.pendingFlushHandle = this.scheduleFn(() => this.flush());
    }

    /** Cancels any pending flush and drops all tracked layer state. */
    destroy(): void {
        if (this.pendingFlushHandle !== null) {
            this.cancelFn(this.pendingFlushHandle);
            this.pendingFlushHandle = null;
        }
        this.entries.clear();
        this.deck = null;
        this.dirty = false;
    }
}
