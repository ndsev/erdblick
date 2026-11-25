import {Injectable} from '@angular/core';
import {z} from 'zod';
import {AppStateService} from '../appstate/appstate.service';

/** Display units and browser-local placement of the drawing toolbar. */
@Injectable({providedIn: 'root'})
export class DrawingState {
    readonly unit;
    readonly toolbarPosition;
    /** Register before application hydration, including the headless catalog build. */
    constructor(state: AppStateService) {
        this.unit = state.registerState<'meters' | 'miles'>({name: 'measurementUnit', defaultValue: 'meters',
            schema: z.enum(['meters', 'miles']), configDefault: true, snapshotPersist: true});
        this.toolbarPosition = state.registerState<{left: number; top: number} | null>({
            name: 'drawingToolbarPosition', defaultValue: null,
            schema: z.object({left: z.number().finite(), top: z.number().finite()}).nullable(),
            configDefault: false, snapshotPersist: false
        });
    }
}
