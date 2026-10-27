import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { stateOwners, testPersistence } from '../../support/state-owners';
import type { RuntimeVersions } from '../../../app/diagnostics/version.model';

/** Runtime labels must never acquire the ownership rules of saved preferences. */
describe('diagnostics runtime versions', () => {
    it('publishes detached, immutable snapshots without exporting version labels as preferences', () => {
        const persistence = testPersistence();
        const state = stateOwners(persistence).diagnostics.state;
        const observed: RuntimeVersions[] = [];
        state.versions$.subscribe(versions => observed.push(versions));
        const supplied = [{ name: 'MapViewer', tag: '2026.5.0' }];

        state.setRuntimeVersions({ distributionVersions: supplied, erdblickVersion: '' });
        supplied[0].tag = 'changed by caller';
        const distribution = state.versions;
        state.setRuntimeVersions({ distributionVersions: [], erdblickVersion: 'Erdblick 2026.5.0' });

        expect(observed).toHaveLength(3);
        expect(distribution.distributionVersions[0].tag).toBe('2026.5.0');
        expect(Object.isFrozen(distribution.distributionVersions[0])).toBe(true);
        expect(Object.isFrozen(distribution.distributionVersions)).toBe(true);
        expect(Object.isFrozen(distribution)).toBe(true);
        expect(persistence.exportSnapshot()).not.toHaveProperty('distributionVersions');
        expect(persistence.exportSnapshot()).not.toHaveProperty('erdblickVersion');
        persistence.ngOnDestroy();
    });

    it('accepts old snapshots and server defaults without restoring their version labels', () => {
        const persistence = testPersistence();
        const state = stateOwners(persistence).diagnostics.state;
        state.setRuntimeVersions({ distributionVersions: [], erdblickVersion: 'running build' });
        const historical = {
            erdblickVersion: 'obsolete build',
            distributionVersions: [{ name: 'MapViewer', tag: 'obsolete distribution' }],
            diagnosticsLogFilter: { info: false, warn: true, error: true }
        };

        expect(persistence.importSnapshot(historical)).toEqual([]);
        expect(persistence.seedConfigDefaultState(historical, 'old-config')).toEqual([]);
        expect(state.versions.erdblickVersion).toBe('running build');
        expect(state.versions.distributionVersions).toEqual([]);
        expect(state.diagnosticsLogFilter.info).toBe(false);
        persistence.ngOnDestroy();
    });
});
