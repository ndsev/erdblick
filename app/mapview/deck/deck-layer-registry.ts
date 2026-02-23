export interface DeckLayerLike {
    id: string;
}

export interface DeckLike {
    setProps(props: {layers: DeckLayerLike[]}): void;
}

type ScheduleFn = (cb: () => void) => number;
type CancelFn = (handle: number) => void;

function defaultSchedule(cb: () => void): number {
    if (typeof requestAnimationFrame === "function") {
        return requestAnimationFrame(cb);
    }
    return window.setTimeout(cb, 0);
}

function defaultCancel(handle: number): void {
    if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(handle);
        return;
    }
    clearTimeout(handle);
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
}

export function makeDeckLayerKey(parts: DeckLayerKeyParts): string {
    return `${parts.tileKey}/${parts.styleId}/${parts.hoverMode}/${parts.kind}`;
}

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

    constructor(
        deck: DeckLike | null = null,
        scheduleFn: ScheduleFn = defaultSchedule,
        cancelFn: CancelFn = defaultCancel
    ) {
        this.deck = deck;
        this.scheduleFn = scheduleFn;
        this.cancelFn = cancelFn;
    }

    setDeck(deck: DeckLike | null): void {
        this.deck = deck;
        this.scheduleFlush();
    }

    upsert(key: string, layer: DeckLayerLike, order = 0): void {
        this.entries.set(key, {layer, order});
        this.markDirty();
    }

    remove(key: string): boolean {
        const removed = this.entries.delete(key);
        if (removed) {
            this.markDirty();
        }
        return removed;
    }

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

    clear(): void {
        if (this.entries.size === 0) {
            return;
        }
        this.entries.clear();
        this.markDirty();
    }

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

        this.deck.setProps({layers});
        this.dirty = false;
    }

    get size(): number {
        return this.entries.size;
    }

    private markDirty(): void {
        this.dirty = true;
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (this.pendingFlushHandle !== null) {
            return;
        }
        this.pendingFlushHandle = this.scheduleFn(() => this.flush());
    }

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
