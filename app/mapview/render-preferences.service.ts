import {AppActionService} from "../actions/app-action.service";
import {ControlValue, rejectAction} from "../actions/app-action";
import {renderControls} from "./render-preferences.service.declarations";

import {Injectable} from "@angular/core";
import {z} from "zod";
import {AppStateService} from "../shared/appstate.service";
import {Boolish} from "../shared/app-state";
import {PointCloudPolicy, DEFAULT_POINT_CLOUD_POLICY, pointCloudPolicySchema, pointCloudDetailSchema,
    pointCloudWorkingMemorySchema, pointCloudGpuMemorySchema} from "../shared/point-cloud-policy";
import {clampLod3TileThreshold, DEFAULT_LOD3_TILE_THRESHOLD} from "../shared/lod-policy";
import {clampTileSubsetRenderWorkerCount} from "../shared/tile-render-policy";
import {MAX_NUM_TILES_TO_LOAD} from "../shared/appstate.service";

/** Owns rendering preferences and validates coordinated resource-budget edits. */
@Injectable({providedIn: "root"})
export class RenderPreferencesService {
    constructor(private readonly persistence: AppStateService) {}


    readonly deckAntialiasingEnabledState = this.persistence.registerState<boolean>({
        name: 'deckAntialiasingEnabled',
        defaultValue: true,
        schema: Boolish
    });


    readonly semanticCompositingEnabledState = this.persistence.registerState<boolean>({
        name: 'semanticCompositingEnabled',
        defaultValue: true,
        schema: Boolish
    });


    readonly contactShadingEnabledState = this.persistence.registerState<boolean>({
        name: 'contactShadingEnabled',
        defaultValue: true,
        schema: Boolish
    });


    readonly lod3TileThresholdState = this.persistence.registerState<number>({
        name: 'lod3TileThreshold',
        defaultValue: DEFAULT_LOD3_TILE_THRESHOLD,
        schema: z.coerce.number().int(),
        toStorage: value => clampLod3TileThreshold(value, DEFAULT_LOD3_TILE_THRESHOLD),
        fromStorage: value => clampLod3TileThreshold(value, DEFAULT_LOD3_TILE_THRESHOLD)
    });


    readonly tileSubsetRenderWorkerCountState = this.persistence.registerState<number>({
        name: 'tileSubsetRenderWorkerCount',
        defaultValue: 0,
        schema: z.coerce.number().int(),
        toStorage: value => clampTileSubsetRenderWorkerCount(value),
        fromStorage: value => clampTileSubsetRenderWorkerCount(value)
    });

    readonly pointCloudDownsamplingEnabledState = this.persistence.registerState<boolean>({
        name: 'pointCloudDownsamplingEnabled', defaultValue: DEFAULT_POINT_CLOUD_POLICY.enabled, schema: Boolish
    });

    readonly pointCloudDetailPixelsState = this.persistence.registerState<number>({
        name: 'pointCloudDetailPixels', defaultValue: DEFAULT_POINT_CLOUD_POLICY.detailPixels,
        schema: pointCloudDetailSchema
    });

    readonly pointCloudWorkingMemoryMiBState = this.persistence.registerState<number>({
        name: 'pointCloudWorkingMemoryMiB', defaultValue: DEFAULT_POINT_CLOUD_POLICY.workingMemoryMiB,
        schema: pointCloudWorkingMemorySchema
    });

    readonly pointCloudGpuMemoryMiBState = this.persistence.registerState<number>({
        name: 'pointCloudGpuMemoryMiB', defaultValue: DEFAULT_POINT_CLOUD_POLICY.gpuMemoryMiB,
        schema: pointCloudGpuMemorySchema
    });


    /** Read the same validated policy for Preferences, rendering and worker admission. */
    get pointCloudPolicy(): PointCloudPolicy {
        return {
            enabled: this.pointCloudDownsamplingEnabledState.getValue(),
            detailPixels: this.pointCloudDetailPixelsState.getValue(),
            workingMemoryMiB: this.pointCloudWorkingMemoryMiBState.getValue(),
            gpuMemoryMiB: this.pointCloudGpuMemoryMiBState.getValue()
        };
    }


    /** Validate the whole preference edit before changing any persisted field. */
    setPointCloudPolicy(policy: PointCloudPolicy): void {
        const parsed = pointCloudPolicySchema.parse(policy);
        this.persistence.transaction(() => {
            this.pointCloudDownsamplingEnabledState.next(parsed.enabled);
            this.pointCloudDetailPixelsState.next(parsed.detailPixels);
            this.pointCloudWorkingMemoryMiBState.next(parsed.workingMemoryMiB);
            this.pointCloudGpuMemoryMiBState.next(parsed.gpuMemoryMiB);
        });
    }

    /** Presents all resource limits from one completed preference edit. */
    readonly pointCloudPolicyChanges = this.persistence.observe(() => this.pointCloudPolicy,
        (left, right) => left.enabled === right.enabled && left.detailPixels === right.detailPixels &&
            left.workingMemoryMiB === right.workingMemoryMiB && left.gpuMemoryMiB === right.gpuMemoryMiB);


    readonly tilesLoadLimitState = this.persistence.registerState<number>({
        name: 'tilesLoadLimit',
        defaultValue: MAX_NUM_TILES_TO_LOAD,
        schema: z.coerce.number().nonnegative(),
        urlParamName: 'tll'
    });

    get deckAntialiasingEnabled() {return this.deckAntialiasingEnabledState.getValue();}

    set deckAntialiasingEnabled(val: boolean) {this.deckAntialiasingEnabledState.next(!!val);}

    get semanticCompositingEnabled() {return this.semanticCompositingEnabledState.getValue();}

    set semanticCompositingEnabled(val: boolean) {this.semanticCompositingEnabledState.next(!!val);}

    get contactShadingEnabled() {return this.contactShadingEnabledState.getValue();}

    set contactShadingEnabled(val: boolean) {this.contactShadingEnabledState.next(!!val);}

    get lod3TileThreshold() {return this.lod3TileThresholdState.getValue();}

    set lod3TileThreshold(val: number) {
        this.lod3TileThresholdState.next(clampLod3TileThreshold(val, DEFAULT_LOD3_TILE_THRESHOLD));
    }

    get tileSubsetRenderWorkerCount() {
        return this.tileSubsetRenderWorkerCountState.getValue();
    }

    set tileSubsetRenderWorkerCount(val: number) {
        this.tileSubsetRenderWorkerCountState.next(
            clampTileSubsetRenderWorkerCount(val)
        );
    }

    get tilesLoadLimit() {return this.tilesLoadLimitState.getValue();}

    set tilesLoadLimit(val: number) {this.tilesLoadLimitState.next(val);}


    /** The public rendering control is a typed view of this owner's preferences. */
    registerActions(actions: AppActionService): void {
        actions.registerControl(renderControls.rendering, {
            read: () => this.renderingPreferences,
            write: (_selector, value) => this.setRenderingPreferences(value)
        });
    }

    get renderingPreferences(): ControlValue<typeof renderControls.rendering> {
        return {antialiasing: this.deckAntialiasingEnabled, semanticCompositing: this.semanticCompositingEnabled,
            contactShading: this.contactShadingEnabled, tileLimit: this.tilesLoadLimit, renderWorkers: this.tileSubsetRenderWorkerCount};
    }

    setRenderingPreferences(value: ControlValue<typeof renderControls.rendering>): void {
        this.persistence.transaction(() => {
            this.deckAntialiasingEnabled = value.antialiasing;
            this.semanticCompositingEnabled = value.semanticCompositing;
            this.contactShadingEnabled = value.contactShading;
            this.tilesLoadLimit = value.tileLimit;
            this.tileSubsetRenderWorkerCount = value.renderWorkers;
        });
    }


}
