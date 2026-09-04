import {Injectable, OnDestroy} from "@angular/core";
import {AppStateService} from "./appstate.service";
import type {CameraViewState} from "./appstate.service";
import {MapViewStateService} from "../mapview/map-view-state.service";

export const PRESENTATION_BRIDGE_PROTOCOL_VERSION = 2;
export const PRESENTATION_BRIDGE_READY = "erdblick:presentation:ready";
export const PRESENTATION_BRIDGE_APPLY = "erdblick:presentation:apply-state";
export const PRESENTATION_BRIDGE_RESULT = "erdblick:presentation:result";
export const PRESENTATION_BRIDGE_START_FLIGHT = "erdblick:presentation:start-camera-flight";
export const PRESENTATION_BRIDGE_STOP_FLIGHT = "erdblick:presentation:stop-camera-flight";

interface PresentationCameraWaypoint {
    lon: number;
    lat: number;
    alt: number;
    heading: number;
    pitch: number;
    roll: number;
}

interface PresentationCameraFlight {
    durationMs: number;
    turnDurationMs: number;
    pingPong: boolean;
    canvasOnly: boolean;
    waypoints: PresentationCameraWaypoint[];
}

interface PresentationApplyRequest {
    requestId: number;
    state: Record<string, unknown>;
    origin: string;
}

type PresentationBridgeError = "invalid-message" | "invalid-state" | "state-application-failed";

/** Applies native state snapshots requested by an explicitly embedded presentation parent. */
@Injectable({providedIn: "root"})
export class PresentationStateBridgeService implements OnDestroy {
    private browserWindow?: Window;
    private parentOrigin?: string;
    private applying = false;
    private queuedRequest?: PresentationApplyRequest;
    private flightFrame?: number;

    constructor(
        private readonly stateService: AppStateService,
        private readonly mapViewState: MapViewStateService
    ) {}

    /** Enables the bridge for a framed document carrying the presentation opt-in. */
    initialize(browserWindow: Window = window): boolean {
        if (this.browserWindow) {
            return true;
        }
        if (browserWindow.parent === browserWindow
            || new URLSearchParams(browserWindow.location.search).get("embed") !== "presentation") {
            return false;
        }

        this.browserWindow = browserWindow;
        browserWindow.addEventListener("message", this.handleMessage);
        browserWindow.parent.postMessage({
            type: PRESENTATION_BRIDGE_READY,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION
        }, "*");
        return true;
    }

    /** Removes the global listener and drops work that has not started yet. */
    ngOnDestroy(): void {
        this.browserWindow?.removeEventListener("message", this.handleMessage);
        this.stopCameraFlight();
        this.browserWindow = undefined;
        this.parentOrigin = undefined;
        this.queuedRequest = undefined;
    }

    private readonly handleMessage = (event: MessageEvent<unknown>): void => {
        const browserWindow = this.browserWindow;
        if (!browserWindow || event.source !== browserWindow.parent) {
            return;
        }

        if (isStopFlightMessage(event.data)) {
            if (this.acceptsControlMessage(event.origin, event.data)) {
                this.stopCameraFlight();
            }
            return;
        }
        if (isStartFlightMessage(event.data)) {
            if (this.acceptsControlMessage(event.origin, event.data)) {
                const flight = presentationCameraFlight(event.data["flight"]);
                if (flight) {
                    this.startCameraFlight(flight);
                }
            }
            return;
        }
        if (!isApplyMessage(event.data)) {
            return;
        }

        const requestId = event.data["requestId"];
        if (!isRequestId(requestId) || !isConcreteOrigin(event.origin)) {
            return;
        }
        if (this.parentOrigin && event.origin !== this.parentOrigin) {
            return;
        }
        if (event.data["version"] !== PRESENTATION_BRIDGE_PROTOCOL_VERSION
            || !isStateObject(event.data["state"])) {
            this.postResult(requestId, event.origin, false, "invalid-message");
            return;
        }

        this.parentOrigin ??= event.origin;
        this.stopCameraFlight();
        const request: PresentationApplyRequest = {
            requestId,
            state: event.data["state"],
            origin: event.origin
        };
        if (this.applying) {
            this.queuedRequest = request;
            return;
        }
        void this.applyRequests(request);
    };

    /** Pins presentation control to the same concrete parent and protocol version. */
    private acceptsControlMessage(origin: string, data: Record<string, unknown>): boolean {
        if (!isConcreteOrigin(origin)
            || data["version"] !== PRESENTATION_BRIDGE_PROTOCOL_VERSION
            || (this.parentOrigin && this.parentOrigin !== origin)) {
            return false;
        }
        this.parentOrigin ??= origin;
        return true;
    }

    /** Publishes interpolated camera poses without writing browser history or persisted app state. */
    private startCameraFlight(flight: PresentationCameraFlight): void {
        this.stopCameraFlight();
        const browserWindow = this.browserWindow;
        if (!browserWindow) {
            return;
        }
        browserWindow.document?.body.classList.toggle("presentation-canvas-only", flight.canvasOnly);
        const startedAt = browserWindow.performance.now();
        const frame = (now: number) => {
            if (!this.browserWindow) {
                return;
            }
            const turnDurationMs = flight.pingPong ? flight.turnDurationMs : 0;
            const cycleDurationMs = flight.durationMs + turnDurationMs;
            const cycle = Math.floor((now - startedAt) / cycleDurationMs);
            const elapsedInCycle = (now - startedAt) % cycleDurationMs;
            const reverse = flight.pingPong && cycle % 2 === 1;
            const travelling = elapsedInCycle < flight.durationMs || turnDurationMs === 0;
            const travelProgress = Math.min(1, elapsedInCycle / flight.durationMs);
            const easedTravelProgress = smootherStep(travelProgress);
            const pathProgress = reverse ? 1 - easedTravelProgress : easedTravelProgress;
            const cameraViewData = interpolateFlight(
                flight.waypoints,
                travelling ? pathProgress : reverse ? 0 : 1
            );
            cameraViewData.orientation.heading += cycle * Math.PI;
            if (!travelling) {
                const turnProgress = (elapsedInCycle - flight.durationMs) / turnDurationMs;
                cameraViewData.orientation.heading += Math.PI * smootherStep(turnProgress);
            }
            this.mapViewState.presentationCameraViewStateTopic.next({
                targetView: 0,
                cameraViewData
            });
            this.flightFrame = this.browserWindow.requestAnimationFrame(frame);
        };
        this.flightFrame = browserWindow.requestAnimationFrame(frame);
    }

    private stopCameraFlight(): void {
        if (this.flightFrame !== undefined && this.browserWindow) {
            this.browserWindow.cancelAnimationFrame(this.flightFrame);
        }
        this.flightFrame = undefined;
        this.browserWindow?.document?.body.classList.remove("presentation-canvas-only");
    }

    /** Serializes state changes and retains only the newest waiting request. */
    private async applyRequests(firstRequest: PresentationApplyRequest): Promise<void> {
        this.applying = true;
        let request: PresentationApplyRequest | undefined = firstRequest;
        while (request && this.browserWindow) {
            try {
                const errors = await Promise.resolve(
                    this.stateService.replaceSnapshotState(request.state)
                );
                if (errors.length) {
                    console.warn("[PresentationStateBridge] Rejected presentation state.", errors);
                    this.postResult(request.requestId, request.origin, false, "invalid-state");
                } else {
                    this.postResult(request.requestId, request.origin, true);
                }
            } catch {
                this.postResult(request.requestId, request.origin, false, "state-application-failed");
            }
            request = this.queuedRequest;
            this.queuedRequest = undefined;
        }
        this.applying = false;
    }

    /** Replies only to the pinned parent and never includes application state. */
    private postResult(
        requestId: number,
        origin: string,
        ok: boolean,
        error?: PresentationBridgeError
    ): void {
        const browserWindow = this.browserWindow;
        if (!browserWindow || (this.parentOrigin && origin !== this.parentOrigin)) {
            return;
        }
        browserWindow.parent.postMessage({
            type: PRESENTATION_BRIDGE_RESULT,
            version: PRESENTATION_BRIDGE_PROTOCOL_VERSION,
            requestId,
            ok,
            ...(error ? {error} : {})
        }, origin);
    }
}

/** Narrows unrelated window messages without responding to them. */
function isApplyMessage(value: unknown): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && (value as Record<string, unknown>)["type"] === PRESENTATION_BRIDGE_APPLY;
}

function isStartFlightMessage(value: unknown): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && (value as Record<string, unknown>)["type"] === PRESENTATION_BRIDGE_START_FLIGHT;
}

function isStopFlightMessage(value: unknown): value is Record<string, unknown> {
    return typeof value === "object"
        && value !== null
        && (value as Record<string, unknown>)["type"] === PRESENTATION_BRIDGE_STOP_FLIGHT;
}

/** Rejects oversized and non-finite motion programs at the trust boundary. */
function presentationCameraFlight(value: unknown): PresentationCameraFlight | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    const raw = value as Record<string, unknown>;
    if (!Number.isFinite(raw["durationMs"])
        || Number(raw["durationMs"]) < 1_000
        || Number(raw["durationMs"]) > 300_000
        || typeof raw["pingPong"] !== "boolean"
        || !Array.isArray(raw["waypoints"])
        || raw["waypoints"].length < 2
        || raw["waypoints"].length > 64) {
        return null;
    }
    const waypointFields = ["lon", "lat", "alt", "heading", "pitch", "roll"] as const;
    const waypoints: PresentationCameraWaypoint[] = [];
    for (const value of raw["waypoints"]) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return null;
        }
        const waypoint = value as Record<string, unknown>;
        if (!waypointFields.every(field => typeof waypoint[field] === "number"
            && Number.isFinite(waypoint[field]))) {
            return null;
        }
        waypoints.push(Object.fromEntries(
            waypointFields.map(field => [field, waypoint[field]])
        ) as unknown as PresentationCameraWaypoint);
    }
    const turnDurationMs = raw["turnDurationMs"] === undefined ? 0 : Number(raw["turnDurationMs"]);
    if (!Number.isFinite(turnDurationMs) || turnDurationMs < 0 || turnDurationMs > 30_000) {
        return null;
    }
    const canvasOnly = raw["canvasOnly"] ?? false;
    if (typeof canvasOnly !== "boolean") {
        return null;
    }
    return {
        durationMs: Number(raw["durationMs"]),
        turnDurationMs,
        pingPong: raw["pingPong"],
        canvasOnly,
        waypoints
    };
}

/** Interpolates equal-duration segments with continuous position and orientation tangents. */
function interpolateFlight(
    waypoints: PresentationCameraWaypoint[],
    progress: number
): CameraViewState {
    const segmentPosition = Math.min(1, Math.max(0, progress)) * (waypoints.length - 1);
    const segmentIndex = Math.min(waypoints.length - 2, Math.floor(segmentPosition));
    const amount = segmentPosition - segmentIndex;
    const from = waypoints[segmentIndex];
    const to = waypoints[segmentIndex + 1];
    const before = waypoints[Math.max(0, segmentIndex - 1)];
    const after = waypoints[Math.min(waypoints.length - 1, segmentIndex + 2)];
    const spline = (field: "lon" | "lat" | "alt" | "pitch" | "roll") => catmullRom(
        before[field], from[field], to[field], after[field], amount
    );
    const heading0 = unwrapAngle(before.heading, from.heading);
    const heading2 = unwrapAngle(to.heading, from.heading);
    const heading3 = unwrapAngle(after.heading, heading2);
    return {
        destination: {
            lon: spline("lon"),
            lat: spline("lat"),
            alt: spline("alt")
        },
        orientation: {
            heading: catmullRom(heading0, from.heading, heading2, heading3, amount),
            pitch: spline("pitch"),
            roll: spline("roll")
        },
        position: [0, 0, 0]
    };
}

/** Quintic easing gives both translation and the endpoint turn zero velocity and acceleration. */
function smootherStep(value: number): number {
    const t = Math.min(1, Math.max(0, value));
    return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Uniform Catmull–Rom interpolation is appropriate for the route's evenly spaced samples. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
        2 * p1
        + (-p0 + p2) * t
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
        + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
}

/** Selects the representation of an angle nearest to a reference angle. */
function unwrapAngle(value: number, reference: number): number {
    const tau = Math.PI * 2;
    return reference + ((value - reference + Math.PI) % tau + tau) % tau - Math.PI;
}

/** Accepts monotonic presentation request identifiers without coercion. */
function isRequestId(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Performs the cheap envelope check; AppStateService owns semantic validation. */
function isStateObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects opaque origins because they cannot be pinned as a postMessage target. */
function isConcreteOrigin(origin: string): boolean {
    try {
        const parsed = new URL(origin);
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
            && parsed.origin === origin;
    } catch {
        return false;
    }
}
