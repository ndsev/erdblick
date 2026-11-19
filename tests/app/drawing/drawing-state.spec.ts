import '@angular/compiler';
import {describe, expect, it} from 'vitest';
import {stateOwners, testPersistence} from '../../support/state-owners';
import {coreLib} from '../../../app/integrations/wasm.adapter';

/** Verify that local catalogs use the ordinary tree state API without persistent identities. */
describe('Drawing state isolation', () => {
    it('accepts configured units before preference hydration', () => {
        const persistence = testPersistence(), {drawing} = stateOwners(persistence);
        expect(persistence.seedConfigDefaultState({measurementUnit: 'miles'}, 'drawing-units')).toEqual([]);
        expect(drawing.unit.value).toBe('miles');
        persistence.ngOnDestroy();
    });
    it('keeps toolbar placement out of shared snapshots and URLs', () => {
        const persistence = testPersistence(), {drawing, url} = stateOwners(persistence);
        drawing.toolbarPosition.next({left: 400, top: 150});
        expect(JSON.stringify(persistence.exportSnapshot())).not.toContain('drawingToolbarPosition');
        expect(JSON.stringify(url.serialize({}))).not.toContain('drawingToolbarPosition');
        expect(drawing.toolbarPosition.configDefault).toBe(false);
        persistence.ngOnDestroy();
    });
    it('keeps virtual visibility and options separate from snapshots and layer dictionaries', () => {
        const persistence = testPersistence(), {layerState: state, viewSettings} = stateOwners(persistence);
        state.registerVirtualMap('drawing-a');
        state.hasAuthoritativeUrlLayerList = true;
        expect(state.materializeLayerDefaults('drawing-a', 'Drawing')[0].visible).toBe(true);
        state.setMapLayerConfig('drawing-a', 'Drawing', [{visible: false, autoLevel: true, level: 0}]);
        state.setStyleOptionValues('drawing-a', 'Drawing', 'Drawing', 'color', ['red']);
        expect(state.mapLayerConfig('drawing-a', 'Drawing')[0].visible).toBe(false);
        expect(state.styleOptionValues('drawing-a', 'Drawing', 'Drawing', 'color', 'string', 'blue')).toEqual(['red']);
        expect(state.layerNames).toEqual([]);
        expect(state.styles.size).toBe(0);
        expect(JSON.stringify(persistence.exportSnapshot())).not.toContain('drawing-a');
        state.removeVirtualMap('drawing-a');
        state.registerVirtualMap('drawing-a');
        expect(state.mapLayerConfig('drawing-a', 'Drawing')[0].visible).toBe(true);
        expect(viewSettings.viewIds).toHaveLength(1);
        persistence.ngOnDestroy();
    });

    it('excludes local inspection references from both snapshot and URL dictionaries', () => {
        const persistence = testPersistence(), owners = stateOwners(persistence), state = owners.inspectionState.state;
        state.registerSessionMap('drawing-local');
        const local = coreLib.createMapTileKey('Features', 'drawing-local', 'Drawing', 'object/0');
        const remote = coreLib.createMapTileKey('Features', 'Remote', 'Road', 'object/0');
        state.selection = [{id: 1, locked: false, size: [20, 20], color: '#fff314', undocked: false,
            features: [{mapTileKey: local, featureId: 'DrawingFeature.1'}, {mapTileKey: remote, featureId: 'Road.1'}]}];
        const url = owners.url.serialize({});
        expect(JSON.stringify(url)).not.toContain('drawing-local');
        expect(JSON.stringify(url)).toContain('Remote');
        expect(JSON.stringify(persistence.exportSnapshot())).not.toContain('drawing-local');
        expect(state.selection[0].features).toHaveLength(2);
        persistence.ngOnDestroy();
    });
});
