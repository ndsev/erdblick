/**
 * Configure Zone before it loads so high-frequency wheel input stays on the browser's native
 * event path. deck.gl/mjolnir owns map-wheel handling; Erdblick currently has no Angular-owned
 * wheel callbacks that require change detection.
 */
(globalThis as typeof globalThis & {
    __zone_symbol__UNPATCHED_EVENTS?: string[];
}).__zone_symbol__UNPATCHED_EVENTS = ["wheel"];
