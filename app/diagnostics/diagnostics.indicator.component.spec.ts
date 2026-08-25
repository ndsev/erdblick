import "@angular/compiler";
import {BehaviorSubject} from "rxjs";
import {describe, expect, it, vi} from "vitest";

import {DiagnosticsIndicatorComponent} from "./diagnostics.indicator.component";
import type {DiagnosticsSnapshot, LogEntry} from "./diagnostics.model";

function snapshot(
    loaded: number,
    expected: number,
    errors = 0
): DiagnosticsSnapshot {
    return {
        at: loaded,
        tiles: {expected, loaded, cached: 0, errors},
        progress: {
            backend: {done: loaded, total: expected},
            rendered: {done: loaded, total: expected},
            bubbles: {
                downstreamBytesPerSecond: 0,
                pullResponses: 0,
                pullGzipResponses: 0,
                pullUncompressedBytes: 0,
                pullCompressedBytesKnown: 0,
                pullCompressionRatioPct: null,
                pullCompressionCoveragePct: 0,
                features: 0,
                vertices: 0,
                parseQueueSize: 0,
                renderQueueSize: 0,
                frameTimeMs: 0,
                renderSeconds: 0
            }
        },
        backend: {connected: true}
    };
}

describe("DiagnosticsIndicatorComponent", () => {
    it("renders diagnostics updates through a local check outside Angular", () => {
        const snapshot$ = new BehaviorSubject(snapshot(0, 2));
        const logs$ = new BehaviorSubject<LogEntry[]>([]);
        const paused$ = new BehaviorSubject(false);
        const detectChanges = vi.fn();
        const markForCheck = vi.fn();
        const runOutsideAngular = vi.fn((callback: () => void) => callback());
        const component = new (DiagnosticsIndicatorComponent as any)(
            {snapshot$, logs$},
            {
                tilePipelinePaused$: paused$,
                get tilePipelinePaused() {
                    return paused$.getValue();
                }
            },
            {detectChanges, markForCheck},
            {runOutsideAngular}
        ) as any;

        expect(detectChanges).not.toHaveBeenCalled();
        component.ngAfterViewInit();

        snapshot$.next(snapshot(2, 2));

        expect(component.snapshot.tiles.loaded).toBe(2);
        expect(component.showSpinner).toBe(false);
        expect(detectChanges).toHaveBeenCalledTimes(1);
        expect(markForCheck).not.toHaveBeenCalled();
        expect(runOutsideAngular).toHaveBeenCalledTimes(1);

        logs$.next([{at: 1, level: "error", message: "failure"}]);
        logs$.next([]);

        expect(component.hasError).toBe(true);
        expect(detectChanges).toHaveBeenCalledTimes(3);

        component.ngOnDestroy();
        snapshot$.next(snapshot(1, 2));
        expect(detectChanges).toHaveBeenCalledTimes(3);
    });

    it("uses OnPush change detection around the manually refreshed view", () => {
        expect((DiagnosticsIndicatorComponent as any).ɵcmp.onPush).toBe(true);
    });
});
