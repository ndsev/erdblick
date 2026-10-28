import "@angular/compiler";
import {ChangeDetectorRef} from "@angular/core";
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from "vitest";
import {testPersistence} from "../../support/state-owners";
import {Cartographic} from "../../../app/integrations/geo.adapter";
import {CoordinatesPanelComponent} from "../../../app/coordinates/coordinates-panel.component";
import {CoordinatesService} from "../../../app/coordinates/coordinates.service";
import {CoordinatesState} from "../../../app/coordinates/coordinates.state";

describe("coordinate panel frame updates", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("coalesces renderer coordinates at an animation-frame boundary", async () => {
        vi.useFakeTimers();
        vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback =>
            window.setTimeout(() => callback(performance.now()), 16));
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation(handle =>
            window.clearTimeout(handle));

        const persistence = testPersistence();
        const coordinates = new CoordinatesService(persistence, {} as never, new CoordinatesState(persistence));
        const detectChanges = vi.fn();
        const panel = new CoordinatesPanelComponent(
            {} as never, coordinates, {} as never, persistence,
            {detectChanges} as unknown as ChangeDetectorRef, {} as never
        );

        coordinates.mouseMoveCoordinates.next(Cartographic.fromDegrees(10, 47));
        coordinates.mouseMoveCoordinates.next(Cartographic.fromDegrees(11, 48));

        expect(panel.longitude).toBeUndefined();
        expect(detectChanges).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(16);

        expect(panel.longitude).toBeCloseTo(11);
        expect(panel.latitude).toBeCloseTo(48);
        expect(detectChanges).toHaveBeenCalledTimes(1);

        panel.ngOnDestroy();
        coordinates.mouseMoveCoordinates.next(Cartographic.fromDegrees(12, 49));
        await vi.advanceTimersByTimeAsync(16);
        expect(panel.longitude).toBeCloseTo(11);
        expect(detectChanges).toHaveBeenCalledTimes(1);
        persistence.ngOnDestroy();
    });
});
