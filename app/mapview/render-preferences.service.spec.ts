import { stateOwners } from '../../test/state-owners';
import '@angular/compiler';
import { describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';
import { Router } from '@angular/router';
import { AppStateService } from "../shared/appstate.service";
import { InfoMessageService } from '../shared/info.service';
import { RenderPreferencesService } from './render-preferences.service';

/** Creates persistence without starting URL hydration or a rendering worker. */
function createPreferences() {
    const router = {
        events: new Subject(), navigate: vi.fn(),
        routerState: { snapshot: { root: { queryParams: {} } } }
    } as unknown as Router;
    const persistence = new AppStateService(router, {} as InfoMessageService);
    return { persistence, preferences: stateOwners(persistence).renderPreferences };
}

describe('service-owned rendering preferences', () => {
    it('publishes a complete resource-budget edit once and retains historical snapshots', () => {
        const { preferences } = createPreferences();
        const policies: typeof preferences.pointCloudPolicy[] = [];
        preferences.pointCloudPolicyChanges.subscribe(policy => policies.push(policy));
        const original = { ...policies[0] };
        const next = { enabled: true, detailPixels: 8, workingMemoryMiB: 128, gpuMemoryMiB: 64 };
        preferences.setPointCloudPolicy(next);
        expect(policies).toEqual([original, next]);
        expect(policies[0]).toEqual(original);
    });

    it('validates the complete edit before changing any slot', () => {
        const { preferences } = createPreferences();
        const before = preferences.pointCloudPolicy;
        expect(() => preferences.setPointCloudPolicy({ ...before, gpuMemoryMiB: 0 })).toThrow();
        expect(preferences.pointCloudPolicy).toEqual(before);
    });

    it('preserves external config keys and excludes local rendering choices from URLs', () => {
        const { persistence, preferences } = createPreferences();
        expect(persistence.importSnapshot({ deckAntialiasingEnabled: false, pointCloudDetailPixels: 8 })).toEqual([]);
        expect(preferences.deckAntialiasingEnabled).toBe(false);
        expect(preferences.pointCloudPolicy.detailPixels).toBe(8);
        expect(preferences.deckAntialiasingEnabledState.serialize(true)).toBeUndefined();
        expect(persistence.exportSnapshot()['pointCloudDetailPixels']).toBe(8);
    });
});
