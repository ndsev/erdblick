import { Injectable } from "@angular/core";
import { z } from "zod";
import { ActionRegistry } from "../actions/action-registry.service";
import { ControlValue } from "../actions/app-action";
import { AppActionContributor } from "../actions/app-action-contributor";
import { PointCloudPolicy, pointCloudPolicySchema } from "../shared/point-cloud-policy";
import { AppStateService } from "../state/app-state.service";
import { RenderPreferencesStore } from "./render-preferences.store";

/**
 * Validates and applies coordinated rendering and resource-budget edits.
 * Renderers observe RenderPreferencesStore directly; this controller contributes
 * the public controls and keeps compound preference changes in one transaction.
 */
@Injectable({ providedIn: "root" })
export class RenderPreferencesService implements AppActionContributor {
    constructor(private readonly persistence: AppStateService,
        public readonly store: RenderPreferencesStore) { }

    /** Validate the whole preference edit before changing any persisted field. */
    setPointCloudPolicy(policy: PointCloudPolicy): void {
        const parsed = pointCloudPolicySchema.parse(policy);
        this.persistence.transaction(() => {
            this.store.pointCloudDownsamplingEnabledState.next(parsed.enabled);
            this.store.pointCloudDetailPixelsState.next(parsed.detailPixels);
            this.store.pointCloudWorkingMemoryMiBState.next(parsed.workingMemoryMiB);
            this.store.pointCloudGpuMemoryMiBState.next(parsed.gpuMemoryMiB);
        });
    }

    /** Registers typed state readers and writers without exposing persistence keys. */
    registerControls(actions: ActionRegistry): void {
        actions.registerControl(renderControls.rendering, {
            read: () => this.store.renderingPreferences,
            write: (_selector, value) => this.setRenderingPreferences(value)
        });
    }

    /** Publish renderer quality and budget changes as one completed preference edit. */
    setRenderingPreferences(value: ControlValue<typeof renderControls.rendering>): void {
        this.persistence.transaction(() => {
            this.store.deckAntialiasingEnabled = value.antialiasing;
            this.store.semanticCompositingEnabled = value.semanticCompositing;
            this.store.contactShadingEnabled = value.contactShading;
            this.store.tilesLoadLimit = value.tileLimit;
            this.store.tileSubsetRenderWorkerCount = value.renderWorkers;
        });
    }

}


/** RenderPreferencesService exposes rendering quality, worker count and tile budget. */
export const renderControls = {
    rendering: {
        name: "app.preferences.rendering",
        description: "Rendering quality, tile budget and worker count (0=automatic). Only tile budget is included in URLs.",
        selectorSchema: z.strictObject({}),
        valueSchema: z.strictObject({
            antialiasing: z.boolean(),
            semanticCompositing: z.boolean(),
            contactShading: z.boolean(),
            tileLimit: z.number().int().min(1).max(1000000),
            renderWorkers: z.number().int().min(0).max(32)
        }),
        readable: true,
        writable: true,
        synchronization: "none",
        persistence: "mixed"
    }
} as const;
