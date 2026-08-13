import type {
    InteractionState,
    MapInteractionTarget,
    MapInteractionTargetContext
} from "@deck.gl/core";
import type {
    NavigationAnchor,
    NavigationScreenPosition,
    NavigationVisualTarget
} from "./feature-navigation.types";
import {isNavigationAnchorUsable} from "./web-mercator-feature-navigation";

/** Product callbacks retained on the Erdblick side of deck.gl's numeric target API. */
export interface ErdblickTargetNavigationAdapterOptions {
    viewId: string;
    resolveTarget: (
        screenPosition: NavigationScreenPosition
    ) => NavigationVisualTarget | null;
    getRetainedTarget: () => NavigationVisualTarget | null;
    onTargetChange: (target: NavigationVisualTarget, active: boolean) => void;
}

/**
 * Adapts Erdblick's rich feature target to deck.gl's coordinate-only controller contract.
 *
 * Feature identity, surface normals, retained selection, and visual lifetime never cross the
 * deck.gl boundary. The controller receives only a numeric coordinate and its exact projected
 * CSS-pixel position; the public interaction state is then used to drive Erdblick's lifecycle.
 */
export class ErdblickTargetNavigationAdapter {
    private pendingTarget: NavigationVisualTarget | null = null;
    private activeTarget: NavigationVisualTarget | null = null;

    constructor(private readonly options: ErdblickTargetNavigationAdapterOptions) {}

    /** Synchronous provider installed as MapController's `getInteractionTarget` option. */
    readonly resolveInteractionTarget = (
        context: Readonly<MapInteractionTargetContext>
    ): MapInteractionTarget | null => {
        // A resolver exception or rejected sample must never leave semantic metadata queued for
        // a later, unrelated controller state update.
        this.pendingTarget = null;
        if (context.viewId !== this.options.viewId) {
            return null;
        }

        const requestedPosition: NavigationScreenPosition = context.screenPosition
            ? [...context.screenPosition]
            : [context.viewport.width / 2, context.viewport.height / 2];
        const retainedTarget = context.screenPosition
            ? null
            : this.options.getRetainedTarget();
        const target = retainedTarget && this.isUsable(retainedTarget.position, context)
            ? retainedTarget
            : this.options.resolveTarget(requestedPosition);
        if (!target) {
            return null;
        }

        const info = context.viewport.getTargetInfo(target.position);
        if (!info?.isVisible
            || !isNavigationAnchorUsable(context.viewport, target.position, true)) {
            return null;
        }

        const position: NavigationAnchor = [...info.target];
        this.pendingTarget = target.surfaceNormal
            ? {position, surfaceNormal: [...target.surfaceNormal]}
            : {position};
        return {
            coordinate: [...position],
            // Erdblick anchors can be snapped from a pick proxy or path ribbon. Preserve the
            // snapped coordinate's actual projected pixel rather than claiming the raw pointer.
            screenPosition: [info.projectedPosition[0], info.projectedPosition[1]]
        };
    };

    /** Consumes deck.gl's public coordinate-only lifecycle for this adapter's view. */
    handleInteractionState(interactionState: InteractionState): void {
        if (interactionState.viewId && interactionState.viewId !== this.options.viewId) {
            return;
        }

        const coordinate = interactionState.interactionTargetPosition;
        if (!coordinate) {
            this.pendingTarget = null;
            if (this.activeTarget) {
                const released = this.activeTarget;
                this.activeTarget = null;
                this.options.onTargetChange(released, false);
            }
            return;
        }

        if (this.activeTarget && sameAnchor(this.activeTarget.position, coordinate)) {
            return;
        }
        if (this.activeTarget) {
            const released = this.activeTarget;
            this.activeTarget = null;
            this.options.onTargetChange(released, false);
        }

        const pending = this.pendingTarget;
        const active = pending && sameAnchor(pending.position, coordinate)
            ? pending
            : {position: [...coordinate] as NavigationAnchor};
        this.pendingTarget = null;
        this.activeTarget = active;
        this.options.onTargetChange(active, true);
    }

    /** Clears pending and active application state during external resets/controller swaps. */
    reset(notifyRelease = true): void {
        this.pendingTarget = null;
        if (!this.activeTarget) {
            return;
        }
        const released = this.activeTarget;
        this.activeTarget = null;
        if (notifyRelease) {
            this.options.onTargetChange(released, false);
        }
    }

    /** Applies the same on-screen/front-of-near-plane policy as retained command targets. */
    private isUsable(
        coordinate: NavigationAnchor,
        context: Readonly<MapInteractionTargetContext>
    ): boolean {
        return isNavigationAnchorUsable(context.viewport, coordinate, true);
    }
}

/** Compares controller coordinates at renderer precision without semantic identity. */
function sameAnchor(
    first: readonly number[],
    second: readonly number[]
): boolean {
    return Math.abs(first[0] - second[0]) <= 1e-10
        && Math.abs(first[1] - second[1]) <= 1e-10
        && Math.abs(first[2] - second[2]) <= 1e-4;
}
