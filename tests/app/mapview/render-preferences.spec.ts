import { stateOwners } from "../../support/state-owners";
import '@angular/compiler';
import {
    describe,
    expect,
    it,
    vi
} from "vitest";
import { Subject } from "rxjs";
import { Router } from "@angular/router";
import { AppStateService } from "../../../app/appstate/appstate.service";
import { MessageService } from "primeng/api";

/** Creates persistence without starting URL hydration or a rendering worker. */
function createPreferences() {
    const router = {
        events: new Subject(), navigate: vi.fn(),
        routerState: { snapshot: { root: { queryParams: {} } } }
    } as unknown as Router;
    const persistence = new AppStateService(router, {} as MessageService);
    return { persistence, preferences: stateOwners(persistence).views };
}

describe('service-owned rendering preferences', () => {
    it('publishes a complete sampling edit once and retains historical snapshots', () => {
        const { preferences } = createPreferences();
        const policies: typeof preferences.state.pointCloudPolicy[] = [];
        preferences.state.pointCloudPolicyChanges.subscribe(policy => policies.push(policy));
        const original = { ...policies[0] };
        const next = { ...original, enabled: true, maxPoints: 500_000, detailPixels: 8 };
        preferences.setPointCloudPolicy(next);
        expect(policies).toEqual([original, next]);
        expect(policies[0]).toEqual(original);
    });

    it('validates the complete edit before changing any slot', () => {
        const { preferences } = createPreferences();
        const before = preferences.state.pointCloudPolicy;
        expect(() => preferences.setPointCloudPolicy({ ...before, detailPixels: 0 })).toThrow();
        expect(() => preferences.setPointCloudPolicy({ ...before, enabled: false, maxPoints: 0 })).toThrow();
        expect(preferences.state.pointCloudPolicy).toEqual(before);
    });

    it('preserves external config keys and excludes local rendering choices from URLs', () => {
        const { persistence, preferences } = createPreferences();
        expect(preferences.state.pointCloudPolicy.maxPoints).toBe(14_000_000);
        expect(persistence.importSnapshot({ deckAntialiasingEnabled: false, pointCloudDetailPixels: 8,
            pointCloudMaxPoints: 500_000 })).toEqual([]);
        expect(preferences.state.deckAntialiasingEnabled).toBe(false);
        expect(preferences.state.pointCloudPolicy.detailPixels).toBe(8);
        expect(preferences.state.deckAntialiasingEnabledState.serialize(true)).toBeUndefined();
        expect(persistence.exportSnapshot()['pointCloudDetailPixels']).toBe(8);
        expect(preferences.state.pointCloudPolicy.maxPoints).toBe(500_000);
        expect(persistence.exportSnapshot()['pointCloudMaxPoints']).toBe(500_000);
        expect(preferences.state.pointCloudMaxPointsState.serialize(true)).toBeUndefined();
    });
});
