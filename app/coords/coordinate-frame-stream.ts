import {
    animationFrameScheduler,
    auditTime,
    type Observable,
    type Subscription
} from "rxjs";

/**
 * Coalesces an external coordinate stream to animation frames without turning
 * every pointer sample into a global Angular change-detection pass.
 */
export function subscribeCoordinateFrames<T>(
    source: Observable<T>,
    receive: (value: T) => void
): Subscription {
    return source.pipe(
        auditTime(0, animationFrameScheduler)
    ).subscribe(receive);
}
