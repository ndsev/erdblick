import { Injectable } from "@angular/core";
import { z } from "zod";
import { ActionRegistry } from "../actions/action-registry.service";

import { AppActionContributor } from "../actions/app-action-contributor";
import { PointCloudPolicy, pointCloudPolicySchema } from "./point-cloud-policy";
import { AppStateService } from "../state/app-state.service";
import { RenderingModel } from "./rendering.model";

/**
 * Validates and applies coordinated rendering and resource-budget edits.
 * Renderers observe RenderingModel directly; this controller contributes
 * the public controls and keeps compound preference changes in one transaction.
 */
@Injectable({ providedIn: "root" })
export class RenderPreferencesService implements AppActionContributor {
    constructor(private readonly persistence: AppStateService,
        public readonly model: RenderingModel) { }

    /** Validate the whole preference edit before changing any persisted field. */
    setPointCloudPolicy(policy: PointCloudPolicy): void {
        const parsed = pointCloudPolicySchema.parse(policy);
        this.persistence.transaction(() => {
            this.model.pointCloudDownsamplingEnabledState.next(parsed.enabled);
            this.model.pointCloudDetailPixelsState.next(parsed.detailPixels);
            this.model.pointCloudWorkingMemoryMiBState.next(parsed.workingMemoryMiB);
            this.model.pointCloudGpuMemoryMiBState.next(parsed.gpuMemoryMiB);
        });
    }

    /** Registers typed state readers and writers without exposing persistence keys. */
    registerControls(actions: ActionRegistry): void {
        actions.registerControl(
            {
                name: "app.preferences.rendering",
                description:
                    "Rendering quality, tile budget and worker count (0=automatic). Only tile budget is included in URLs.",
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
            },
            {
                read: () => this.model.renderingPreferences,
                write: (_selector, value) => this.setRenderingPreferences(value)
            }
        );
    }

    /** Publish renderer quality and budget changes as one completed preference edit. */
    setRenderingPreferences(value: {
        antialiasing: boolean;
        semanticCompositing: boolean;
        contactShading: boolean;
        tileLimit: number;
        renderWorkers: number;
    }): void {
        this.persistence.transaction(() => {
            this.model.deckAntialiasingEnabled = value.antialiasing;
            this.model.semanticCompositingEnabled = value.semanticCompositing;
            this.model.contactShadingEnabled = value.contactShading;
            this.model.tilesLoadLimit = value.tileLimit;
            this.model.tileSubsetRenderWorkerCount = value.renderWorkers;
        });
    }

}
