import "@angular/compiler";
import {describe, expect, it, vi} from "vitest";
import type {AppConfigService, ExternalViewerConfig} from "../shared/app-config.service";
import type {AppStateService} from "../shared/appstate.service";
import {ExternalViewerService} from "./external-viewer.service";

const PROVIDERS: ExternalViewerConfig[] = [
    {
        id: "e:gm",
        name: "Open in Google Maps",
        urlTemplate: "https://www.google.com/maps/search/?api=1&query={lat},{lon}"
    },
    {
        id: "e:google-street-view",
        name: "Open in Google Street View",
        urlTemplate: "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={lat},{lon}"
    },
    {
        id: "e:osm",
        name: "Open in OpenStreetMap",
        urlTemplate: "https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=16/{lat}/{lon}"
    },
    {
        id: "e:bing-maps",
        name: "Open in Bing Maps",
        urlTemplate: "https://bing.com/maps/default.aspx?cp={lat}~{lon}&lvl=18&style=r"
    }
];

/** Builds the service with mutable marker, focus, and camera state. */
function createService() {
    const state = {
        marker: false,
        markedPosition: [] as number[],
        focusedView: 0,
        cameraViewDataState: {
            getValue: vi.fn((viewIndex: number) => ({
                destination: viewIndex === 1
                    ? {lon: 11.5, lat: 48.1, alt: 1000}
                    : {lon: -3.2, lat: 52.4, alt: 900}
            }))
        }
    };
    const configService = {
        snapshot: {externalViewers: PROVIDERS}
    };
    return {
        service: new ExternalViewerService(
            state as unknown as AppStateService,
            configService as unknown as AppConfigService
        ),
        state
    };
}

describe("ExternalViewerService", () => {
    it("builds the documented provider URLs without changing coordinate signs", () => {
        const {service} = createService();
        const location = {lat: -33.865143, lon: 179.9999};

        const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

        service.providers.forEach(provider => service.open(provider, location));

        expect(openSpy.mock.calls.map(call => call[0])).toEqual([
            "https://www.google.com/maps/search/?api=1&query=-33.865143,179.9999",
            "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=-33.865143,179.9999",
            "https://www.openstreetmap.org/?mlat=-33.865143&mlon=179.9999#map=16/-33.865143/179.9999",
            "https://bing.com/maps/default.aspx?cp=-33.865143~179.9999&lvl=18&style=r"
        ]);
    });

    it("resolves explicit input before the enabled marker", () => {
        const {service, state} = createService();
        state.marker = true;
        state.markedPosition = [8.4, 49.0, 125];

        expect(service.resolveLocation({lon: 7.1, lat: 50.2})).toEqual({
            lon: 7.1,
            lat: 50.2,
            source: "input"
        });
    });

    it("uses a valid enabled marker before the focused viewport", () => {
        const {service, state} = createService();
        state.marker = true;
        state.markedPosition = [8.4, 49.0];
        state.focusedView = 1;

        expect(service.resolveLocation()).toEqual({lon: 8.4, lat: 49.0, source: "marker"});
        expect(state.cameraViewDataState.getValue).not.toHaveBeenCalled();
    });

    it("uses the focused viewport when the marker is disabled or invalid", () => {
        const {service, state} = createService();
        state.focusedView = 1;
        state.marker = true;
        state.markedPosition = [181, 20];

        expect(service.resolveLocation()).toEqual({lon: 11.5, lat: 48.1, source: "viewport"});
        expect(state.cameraViewDataState.getValue).toHaveBeenCalledWith(1);
    });

    it("opens the provider synchronously in a noopener tab", () => {
        const {service} = createService();
        const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

        service.open(service.providers[0], {lat: 1, lon: 2});

        expect(openSpy).toHaveBeenCalledWith(
            "https://www.google.com/maps/search/?api=1&query=1,2",
            "_blank",
            "noopener"
        );
    });
});
