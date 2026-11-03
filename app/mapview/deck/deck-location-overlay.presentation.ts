import { COORDINATE_SYSTEM } from "@deck.gl/core";
import { IconLayer, TextLayer } from "@deck.gl/layers";
import { Color } from "../../integrations/geo.adapter";
import type { LocationArea, LocationPolygon } from "../render-view.model";
import type { DeckLayerRegistry } from "./deck-layer-registry.util";
import { locationOverlayPolygons } from "./deck-location-area-navigation.util";
import {
    DECK_OVERLAY_PARAMETERS,
    LOCATION_MARKER_ICON_NAME,
    LOCATION_MARKER_ICON_SIZE_PX
} from "./deck-overlay.constants";
import { createRectangleOverlayLayer, rectangleOverlayData, toDeckColor } from "./deck-rectangle-overlay.layer";
import { LocationAreaLayer } from "./location-area.layer";

/** Single location marker datum for the search/jump marker overlay. */
interface DeckLocationMarkerDatum {
    position: [number, number, number];
}

/** Single transient place-name label datum for location-search jumps. */
interface DeckLocationLabelDatum {
    position: [number, number];
    label: string;
    textColor: [number, number, number, number];
    backgroundColor: [number, number, number, number];
}
/** The view supplies its existing frame clock; this owner retires only its own callbacks. */
export interface LocationOverlayClock {
    onTick(callback: () => void): void;
    offTick(callback: () => void): void;
    requestRender(): void;
}

/** Per-canvas location layers and their fades; camera navigation stays with DeckMapView. */
export class DeckLocationOverlay {

    private static readonly JUMP_AREA_LAYER_KEY = "builtin/jump-area";
    private static readonly LOCATION_AREA_LAYER_KEY = "builtin/location-area";
    private static readonly LOCATION_MARKER_LAYER_KEY = "builtin/location-marker";
    private static readonly LOCATION_LABEL_LAYER_KEY = "builtin/location-label";
    private static readonly LOCATION_MARKER_RENDER_SIZE_PX = 32;
    private static readonly LOCATION_LABEL_FADE_DURATION_MS = 4200;
    private static readonly JUMP_AREA_HIGHLIGHT_DURATION_MS = 3000;

    private lastLocationMarkerSignature = "";
    private jumpAreaHighlightTick: (() => void) | null = null;
    private locationAreaHighlightTick: (() => void) | null = null;
    private locationAreaHighlightStartedAt: number | undefined;
    private locationLabelTick: (() => void) | null = null;
    private boundariesEnabled = false;
    private destroyed = false;

    /** Receive rendering capabilities and a typed unavailable-boundary notification, not services. */
    constructor(private readonly layerRegistry: DeckLayerRegistry,
                private readonly clock: LocationOverlayClock,
                private readonly onBoundaryUnavailable: () => void) {}

    /** Apply the application boundary's visibility decision, including to deferred error fallbacks. */
    setBoundariesEnabled(enabled: boolean): void {
        this.boundariesEnabled = enabled;
        if (!enabled) this.stopLocationAreaHighlight();
    }

    /** Begin fading only after Deck has presented the initial tessellated area. */
    onAfterRender(): void {
        if (this.locationAreaHighlightTick && this.locationAreaHighlightStartedAt === undefined) {
            this.locationAreaHighlightStartedAt = performance.now();
        }
    }

    /** Cancel fades and remove layers while the renderer's registry and device are still alive. */
    destroy(): void {
        this.destroyed = true;
        this.stopLocationAreaHighlight();
        this.stopJumpAreaHighlight();
        this.stopLocationLabel();
        this.layerRegistry.remove(DeckLocationOverlay.LOCATION_MARKER_LAYER_KEY);
        this.lastLocationMarkerSignature = "";
    }

    /**
     * Mirrors the legacy Cesium single-location pin as a dedicated deck IconLayer.
     */
    updateLocationMarkerOverlay(markerEnabled: boolean, markedPosition: readonly number[], iconAtlas: string): void {
        if (this.destroyed || !markerEnabled || markedPosition.length < 2) {
            this.layerRegistry.remove(DeckLocationOverlay.LOCATION_MARKER_LAYER_KEY);
            this.lastLocationMarkerSignature = "";
            return;
        }

        const longitude = Number(markedPosition[0]);
        const latitude = Number(markedPosition[1]);
        const altitude = Number(markedPosition[2] ?? 0);
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || !Number.isFinite(altitude)) {
            this.layerRegistry.remove(DeckLocationOverlay.LOCATION_MARKER_LAYER_KEY);
            this.lastLocationMarkerSignature = "";
            return;
        }

        const signature = `${longitude},${latitude},${altitude},${iconAtlas}`;
        if (this.lastLocationMarkerSignature === signature) {
            return;
        }

        this.lastLocationMarkerSignature = signature;
        const iconSize = LOCATION_MARKER_ICON_SIZE_PX;
        const layer = new IconLayer<DeckLocationMarkerDatum>({
            id: DeckLocationOverlay.LOCATION_MARKER_LAYER_KEY,
            data: [{ position: [longitude, latitude, altitude] }],
            coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
            iconAtlas,
            iconMapping: {
                [LOCATION_MARKER_ICON_NAME]: {
                    x: 0,
                    y: 0,
                    width: iconSize,
                    height: iconSize,
                    anchorX: iconSize / 2,
                    anchorY: iconSize,
                    mask: false
                }
            },
            getIcon: () => LOCATION_MARKER_ICON_NAME,
            getPosition: (marker: DeckLocationMarkerDatum) => marker.position,
            getSize: () => DeckLocationOverlay.LOCATION_MARKER_RENDER_SIZE_PX,
            sizeUnits: "pixels",
            billboard: true,
            pickable: false,
            alphaCutoff: 0.05,
            parameters: DECK_OVERLAY_PARAMETERS
        });
        this.layerRegistry.upsert(DeckLocationOverlay.LOCATION_MARKER_LAYER_KEY, layer, 700);
    }

    /** Keeps polygon data/accessors stable during fading so Deck only updates opacity. */
    startLocationAreaHighlight(area: LocationArea): void {
        this.stopLocationAreaHighlight();
        if (this.destroyed || !this.boundariesEnabled) return;
        let data: LocationPolygon[];
        try {
            data = locationOverlayPolygons(area);
        } catch {
            if (area.polygons) {
                this.onBoundaryUnavailable();
                this.startLocationAreaHighlight({ ...area, polygons: undefined });
            }
            return;
        }
        if (!data.length) return;
        const layer = new LocationAreaLayer({
            id: DeckLocationOverlay.LOCATION_AREA_LAYER_KEY,
            data,
            pickable: false,
            parameters: DECK_OVERLAY_PARAMETERS,
            onError: () => {
                // Retire a bad boundary once, outside Deck's layer-update stack.
                queueMicrotask(() => {
                    if (this.locationAreaHighlightTick !== tick) return;
                    this.stopLocationAreaHighlight();
                    if (area.polygons) {
                        this.onBoundaryUnavailable();
                        this.startLocationAreaHighlight({ ...area, polygons: undefined });
                    }
                });
                return true;
            }
        });
        const tick = () => {
            const start = this.locationAreaHighlightStartedAt;
            if (start === undefined) return; // Tessellation and the first frame do not consume the fade.
            const opacity = Math.max(0, 1 - (performance.now() - start) / 3000);
            if (!opacity) { this.stopLocationAreaHighlight(); return; }
            this.layerRegistry.upsert(DeckLocationOverlay.LOCATION_AREA_LAYER_KEY, layer.clone({ opacity }), 510);
            this.clock.requestRender();
        };
        this.locationAreaHighlightTick = tick;
        this.layerRegistry.upsert(DeckLocationOverlay.LOCATION_AREA_LAYER_KEY, layer, 510);
        this.clock.onTick(tick);
        this.clock.requestRender();
    }

    /** Releases the current transient boundary and its animation callback. */
    stopLocationAreaHighlight(): void {
        if (this.locationAreaHighlightTick) this.clock.offTick(this.locationAreaHighlightTick);
        this.locationAreaHighlightTick = null;
        this.locationAreaHighlightStartedAt = undefined;
        this.layerRegistry.remove(DeckLocationOverlay.LOCATION_AREA_LAYER_KEY);
    }

    /** Starts a short-lived animated rectangle highlight for fit-to-rectangle navigation. */
    startJumpAreaHighlight(rectangle: { west: number; south: number; east: number; north: number }): void {
        this.stopJumpAreaHighlight();
        if (this.destroyed) return;

        const startTime = performance.now();
        const tick = () => {
            const elapsedMs = performance.now() - startTime;
            const progress = Math.min(1, elapsedMs / DeckLocationOverlay.JUMP_AREA_HIGHLIGHT_DURATION_MS);
            const fillAlpha = Math.max(0, (1 - progress) * 0.2);
            const lineAlpha = Math.max(0, 1 - progress);
            const data = rectangleOverlayData(
                rectangle.west,
                rectangle.south,
                rectangle.east,
                rectangle.north,
                toDeckColor(Color.AQUA.withAlpha(fillAlpha), [0, 255, 255, 51]),
                toDeckColor(Color.AQUA.withAlpha(lineAlpha), [0, 255, 255, 255]),
                3
            );
            this.layerRegistry.upsert(DeckLocationOverlay.JUMP_AREA_LAYER_KEY,
                createRectangleOverlayLayer(DeckLocationOverlay.JUMP_AREA_LAYER_KEY, data), 510);
            this.clock.requestRender();

            if (progress >= 1) {
                this.stopJumpAreaHighlight();
            }
        };

        this.jumpAreaHighlightTick = tick;
        this.clock.onTick(tick);
        tick();
    }

    /** Stops and removes the temporary jump-area highlight overlay. */
    stopJumpAreaHighlight(): void {
        if (this.jumpAreaHighlightTick) {
            this.clock.offTick(this.jumpAreaHighlightTick);
            this.jumpAreaHighlightTick = null;
        }
        this.layerRegistry.remove(DeckLocationOverlay.JUMP_AREA_LAYER_KEY);
    }

    /** Starts a short-lived place-name label after a location-search jump. */
    startLocationLabel(value: { x: number; y: number; label: string }): void {
        this.stopLocationLabel();

        const longitude = Number(value.x);
        const latitude = Number(value.y);
        const label = value.label.trim().slice(0, 120);
        if (this.destroyed || !Number.isFinite(longitude) || !Number.isFinite(latitude) || !label) {
            return;
        }

        const startTime = performance.now();
        const tick = () => {
            const elapsedMs = performance.now() - startTime;
            const progress = Math.min(1, elapsedMs / DeckLocationOverlay.LOCATION_LABEL_FADE_DURATION_MS);
            const alpha = Math.max(0, 1 - progress);
            const data: DeckLocationLabelDatum[] = [{
                position: [longitude, latitude],
                label,
                textColor: [255, 255, 255, Math.round(alpha * 255)],
                backgroundColor: [0, 0, 0, Math.round(alpha * 235)]
            }];
            this.layerRegistry.upsert(DeckLocationOverlay.LOCATION_LABEL_LAYER_KEY, new TextLayer<DeckLocationLabelDatum>({
                id: DeckLocationOverlay.LOCATION_LABEL_LAYER_KEY,
                data,
                coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
                getPosition: (datum: DeckLocationLabelDatum) => datum.position,
                getText: (datum: DeckLocationLabelDatum) => datum.label,
                getColor: (datum: DeckLocationLabelDatum) => datum.textColor,
                getBackgroundColor: (datum: DeckLocationLabelDatum) => datum.backgroundColor,
                getOutlineColor: () => [0, 0, 0, Math.round(alpha * 255)],
                getOutlineWidth: () => 3,
                getSize: () => 30,
                sizeUnits: "pixels",
                getTextAnchor: () => "middle",
                getAlignmentBaseline: () => "bottom",
                getPixelOffset: () => [0, -44],
                background: true,
                backgroundPadding: [14, 8],
                billboard: true,
                pickable: false,
                parameters: DECK_OVERLAY_PARAMETERS
            } as any) as any, 720);
            this.clock.requestRender();

            if (progress >= 1) {
                this.stopLocationLabel();
            }
        };

        this.locationLabelTick = tick;
        this.clock.onTick(tick);
        tick();
    }

    /** Stops and removes the temporary location-search label overlay. */
    stopLocationLabel(): void {
        if (this.locationLabelTick) {
            this.clock.offTick(this.locationLabelTick);
            this.locationLabelTick = null;
        }
        this.layerRegistry.remove(DeckLocationOverlay.LOCATION_LABEL_LAYER_KEY);
    }
}
