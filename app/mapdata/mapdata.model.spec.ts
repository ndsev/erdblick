import '@angular/compiler';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {StateOwners, testPersistence} from '../../test/state-owners';

afterEach(() => localStorage.clear());

describe('layer catalog defaults', () => {
    it('reads absent layer and option defaults without publishing or claiming ownership', () => {
        const registry = testPersistence();
        const {layerState: layers} = new StateOwners(registry);
        registry['setupStateSubscriptions']();
        registry['isReady'] = true;
        registry['scheduleFlush'] = vi.fn();
        const before = registry.exportSnapshot();
        expect(layers.mapLayerConfig('Map', 'Lane', false, 9)).toEqual([{visible: false, level: 9, autoLevel: true}]);
        expect(layers.styleOptionValues('Map', 'Lane', 'style', 'labels', 'Bool', true)).toEqual([true]);
        expect(registry.exportSnapshot()).toEqual(before);
        expect(layers.styles.size).toBe(0);
        expect(registry['pendingStorageSyncStates'].size).toBe(0);
        expect(registry['pendingUserOwnershipStates'].size).toBe(0);
        registry.ngOnDestroy();
    });

    it('materializes discovered defaults as system state and preserves later user assignments', () => {
        const registry = testPersistence();
        const {layerState: layers} = new StateOwners(registry);
        registry['setupStateSubscriptions']();
        registry['isReady'] = true;
        registry['scheduleFlush'] = vi.fn();
        layers.hasAuthoritativeUrlLayerList = true;
        layers.materializeLayerDefaults('Map', 'Lane', true, 9);
        layers.materializeStyleOptionDefaults('Map', 'Lane', 'style', 'labels', 'Bool', true);
        expect(layers.mapLayerConfig('Map', 'Lane')).toEqual([{visible: false, level: 9, autoLevel: true}]);
        expect(registry['pendingUserOwnershipStates'].size).toBe(0);
        layers.setStyleOptionValues('Map', 'Lane', 'style', 'labels', [false]);
        layers.materializeStyleOptionDefaults('Map', 'Lane', 'style', 'labels', 'Bool', true);
        expect(layers.styleOptionValues('Map', 'Lane', 'style', 'labels', 'Bool', true)).toEqual([false]);
        expect([...registry['pendingUserOwnershipStates']]).toEqual(['styleOptions']);
        registry.ngOnDestroy();
    });
});
