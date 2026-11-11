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
import { InfoMessageService } from "../../../app/diagnostics/info.service";
import { PreferencesComponent } from "../../../app/preferences/preferences.component";
import { PREFERENCES_DIALOG_LAYOUT_ID } from "../../../app/layout/layout.model";

/** Creates persistence without starting URL hydration or a rendering worker. */
function createPreferences() {
    const router = {
        events: new Subject(), navigate: vi.fn(),
        routerState: { snapshot: { root: { queryParams: {} } } }
    } as unknown as Router;
    const persistence = new AppStateService(router, {} as InfoMessageService);
    return { persistence, preferences: stateOwners(persistence).views };
}

describe('service-owned rendering preferences', () => {
    it('opens Rendering from another tab without applying or discarding a pending sampling edit', () => {
        const component = Object.create(PreferencesComponent.prototype);
        component.dialogLayoutId = PREFERENCES_DIALOG_LAYOUT_ID;
        component.activeTab = 'general';
        component.layout = {setDialogOpen: vi.fn()};
        component.dialogStack = {bringToFront: vi.fn()};
        const draft = {enabled: true, maxPoints: 500_000, detailPixels: 8};
        component.pointCloudPolicyDraft = draft;

        component.openRendering();

        expect(component.activeTab).toBe('rendering');
        expect(component.layout.setDialogOpen).toHaveBeenCalledExactlyOnceWith(PREFERENCES_DIALOG_LAYOUT_ID, true);
        expect(component.pointCloudPolicyDraft).toBe(draft);
    });

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
