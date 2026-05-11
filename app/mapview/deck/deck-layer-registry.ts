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

interface SharedLayerEntry {
    buildLayer: (
        key: string,
        contributions: ReadonlyMap<string, unknown>
    ) => {layer: DeckLayerLike | null; order: number};
    contributions: Map<string, unknown>;
}

type RegistryEntry = LayerEntry | SharedLayerEntry;

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
    private readonly entries = new Map<string, RegistryEntry>();
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

    /**
     * Adds or updates one contributor of a shared keyed layer. The final deck layer is synthesized
     * from all contributions during `flush()`.
     */
    upsertShared(
        key: string,
        sourceId: string,
        contribution: unknown,
        buildLayer: (
            key: string,
            contributions: ReadonlyMap<string, unknown>
        ) => {layer: DeckLayerLike | null; order: number}
    ): void {
        const existing = this.entries.get(key);
        if (existing && "buildLayer" in existing) {
            existing.contributions.set(sourceId, contribution);
            existing.buildLayer = buildLayer;
        } else {
            this.entries.set(key, {
                buildLayer,
                contributions: new Map([[sourceId, contribution]])
            });
        }
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

    /** Removes one contributor from a shared keyed layer and drops the layer once empty. */
    removeShared(key: string, sourceId: string): boolean {
        const entry = this.entries.get(key);
        if (!entry || !("buildLayer" in entry)) {
            return false;
        }
        const removed = entry.contributions.delete(sourceId);
        if (!removed) {
            return false;
        }
        if (entry.contributions.size === 0) {
            this.entries.delete(key);
        }
        this.markDirty();
        return true;
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
            .flatMap(([key, entry]) => {
                if ("buildLayer" in entry) {
                    const {layer, order} = entry.buildLayer(key, entry.contributions);
                    return layer ? [{key, layer, order}] : [];
                }
                return [{key, layer: entry.layer, order: entry.order}];
            })
            .sort((a, b) => {
                const orderDiff = a.order - b.order;
                if (orderDiff !== 0) {
                    return orderDiff;
                }
                return a.key.localeCompare(b.key);
            })
            .map((entry) => entry.layer);

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
