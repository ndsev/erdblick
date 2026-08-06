import {
    animationFrameScheduler,
    auditTime,
    type Observable,
    type Subscription
} from "rxjs";

/** Minimal Angular-zone surface needed to re-enter change detection. */
export interface CoordinateFrameZone {
    run(callback: () => void): void;
}

/**
 * Coalesces an external coordinate stream to animation frames and delivers
 * each retained value inside Angular's zone.
 */
export function subscribeCoordinateFrames<T>(
    source: Observable<T>,
    zone: CoordinateFrameZone,
    receive: (value: T) => void
): Subscription {
    return source.pipe(
        auditTime(0, animationFrameScheduler)
    ).subscribe(value => zone.run(() => receive(value)));
}
