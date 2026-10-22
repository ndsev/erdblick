import { CoordinatesModel } from "../coordinates/coordinates.model";
import '@angular/compiler';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OmnibarComponent } from './omnibar.component';
import { CoordinatesService } from '../coordinates/coordinates.service';
import { DiagnosticsFacadeService } from '../diagnostics/diagnostics.facade.service';
import { InspectionSelectionService } from '../inspection/inspection-selection.service';
import { InspectionPanelService } from '../inspection/inspection-panel.service';
import { MapInfoService } from '../mapdata/map-info.service';
import { MapViewModel } from '../mapview/mapview.model';
import { MapViewService } from '../mapview/map-view.service';
import { RightClickMenuService } from '../mapview/rightclickmenu.service';
import { FeatureSearchService } from '../feature-search/feature.search.service';
import { AppConfigService } from '../config/app-config.service';
import { AppStateService } from '../state/app-state.service';
import { InfoMessageService } from '../shared/info.service';
import { Subject } from 'rxjs';
import { StateOwners, testPersistence } from '../../test/state-owners';
import { coreLib, initializeLibrary } from '../integrations/wasm';
import { JumpTargetService } from '../navigation/jump.service';
import { ExternalViewerService } from '../navigation/external-viewer.service';
import { LocationNavigationService } from '../navigation/location-navigation.service';
import { LocationSearchMatch } from '../location-search/location.search.service';
import { ActionRegistry } from '../actions/action-registry.service';
import { viewerActionCatalog, viewerActions } from "../../test/action-contract";

beforeAll(() => initializeLibrary());
afterEach(() => TestBed.resetTestingModule());
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

/** Real owners and registry, with only network and renderer effects controlled. */
function fixture() {
    const state = testPersistence();
    const owners = new StateOwners(state);
    const actions = new ActionRegistry(state);
    const moved = vi.fn();
    const views = {
        generation: 1,
        moveToWgs84PositionTopic: { next: moved }, moveToRectangleTopic: { next: moved },
        showLocationLabelTopic: { next: vi.fn() }, locationBoundaryUnavailableTopic: new Subject<void>(),
        captureView: (index: number): { viewId: string; generation: number } => ({
            viewId: owners.viewSettings.viewIdAt(index), generation: views.generation
        }),
        resolveCapturedView: (target: { viewId: string; generation: number }): object | undefined =>
            owners.viewSettings.viewIds.includes(target.viewId) && target.generation === views.generation ? {} : undefined
    };
    const parser = { filterFeatureJumpTargets: vi.fn(() => []) };
    const maps = { tileLayerParser: parser, maps: { maps: new Map() }, sourceDataLayerIdForLayerName: vi.fn() };
    const menu = { customTileAndMapId: new Subject<[string, string]>() };
    const jumps = new JumpTargetService(maps as never, {} as never, { showError: vi.fn() } as never,
        menu as never, owners.configService, owners.coordinates, owners.inspectionState, owners.viewSettings, views as never);
    jumps.initialize();
    const external = new ExternalViewerService(owners.configService, owners.coordinates.model, owners.viewSettings);
    const navigation = new LocationNavigationService(owners.locationSearch, views as never, state, {} as never, jumps,
        {} as never, owners.viewSettings, {} as never, {} as never, {} as never);
    const run = vi.spyOn(owners.searchService, 'run').mockReturnValue({ id: 'new-search' } as never);
    actions.registerContributors([owners.searchService, jumps, external, navigation, owners.inspectionState]);
    return { state, owners, actions, jumps, external, navigation, parser, views, moved, menu, run };
}

describe('owner action candidates', () => {
    it('constructs the actual jump, context-menu and external-viewer owners together through Angular DI', () => {
        const state = testPersistence();
        const owners = new StateOwners(state);
        TestBed.configureTestingModule({
            providers: [
                JumpTargetService, RightClickMenuService, ExternalViewerService,
                { provide: AppStateService, useValue: state },
                { provide: AppConfigService, useValue: owners.configService },
                { provide: CoordinatesService, useValue: owners.coordinates },
                { provide: CoordinatesModel, useValue: owners.coordinates.model },
                { provide: MapViewModel, useValue: owners.viewSettings },
                { provide: InspectionPanelService, useValue: owners.inspectionState },
                { provide: FeatureSearchService, useValue: owners.searchService },
                { provide: DiagnosticsFacadeService, useValue: owners.diagnostics },
                { provide: InspectionSelectionService, useValue: {} },
                { provide: MapInfoService, useValue: {} },
                { provide: MapViewService, useValue: {} },
                { provide: InfoMessageService, useValue: { showError: vi.fn() } }
            ]
        });
        expect(TestBed.inject(JumpTargetService)).toBeInstanceOf(JumpTargetService);
        expect(TestBed.inject(RightClickMenuService)).toBeInstanceOf(RightClickMenuService);
        expect(TestBed.inject(ExternalViewerService)).toBeInstanceOf(ExternalViewerService);
        state.ngOnDestroy();
    });

    it.each([
        ['j:wgs84-lon-lat', '11,48'], ['j:wgs84-lat-lon', '48,11'],
        ['j:nds-x-y', '123456,987654'], ['j:nds-y-x', '987654,123456'],
        ['j:morton-code', '123456'], ['j:packed-tile-id', '']
    ])('parses and dispatches %s through the common handler', async (id, text) => {
        const h = fixture();
        const query = text || String(coreLib.getTileIdFromPosition(11, 48, 13));
        const candidate = h.actions.getCandidates(query).find(candidate => candidate.id === id)!;
        expect(candidate.enabled).toBe(true);
        expect(await h.actions.execute(candidate.action, candidate.input)).toEqual({ status: 'applied', changed: true });
        expect(h.moved).toHaveBeenCalledOnce();
    });

    it('publishes coordinate marker position and visibility as one completed owner edit', async () => {
        const h = fixture();
        const observations: unknown[] = [];
        const subscription = h.state.observe(() => h.owners.coordinates.model.markerControlValue)
            .subscribe(value => observations.push(value));
        const candidate = h.actions.getCandidates('11,48').find(candidate => candidate.id === 'j:wgs84-lon-lat')!;
        await h.actions.execute(candidate.action, candidate.input);
        expect(observations).toEqual([
            { enabled: false, position: null },
            { enabled: true, position: { lon: 11, lat: 48, alt: 0 } }
        ]);
        subscription.unsubscribe();
    });

    it.each(['reorder', 'remove-and-restore'] as const)('retains the async provider destination through %s', async change => {
        const h = fixture();
        h.owners.viewSettings.importViews(['a', 'b']);
        h.owners.viewSettings.focusedView = 1;
        let resolve!: (value: number[]) => void;
        const result = new Promise<number[]>(done => { resolve = done; });
        h.jumps.extJumpTargets = [{
            id: 'plugin:async', name: 'Async destination', label: 'Async destination', icon: 'pi-map', color: 'green',
            enabled: true, validate: () => true, jump: () => result
        }];
        const candidate = h.actions.getCandidates('route').find(candidate => candidate.id === 'plugin:async')!;
        const execution = h.actions.execute(candidate.action, candidate.input);
        if (change === 'reorder') {
            h.owners.viewSettings.retainViews([1, 0], new Map());
            h.owners.viewSettings.focusedView = 1; // Focus now points to a, while the intent still targets b.
            resolve([48, 11, 100]);
            await execution;
            expect(h.moved).toHaveBeenCalledExactlyOnceWith({ x: 11, y: 48, z: 100, targetView: 0 });
        } else {
            h.owners.viewSettings.retainViews([0], new Map());
            h.views.generation++; // The runtime owner retires the removed renderer's lifetime.
            h.owners.viewSettings.importViews(['a', 'b']);
            resolve([48, 11, 100]);
            await expect(execution).rejects.toThrow('no longer available');
            expect(h.moved).not.toHaveBeenCalled();
            expect(h.owners.coordinates.model.markerControlValue).toEqual({ enabled: false, position: null });
        }
    });

    it('preserves completion scope when resolving feature omnibar history afresh', () => {
        const h = fixture();
        const payload = { selectedMapLayers: [{ mapId: 'Map', layerId: 'Road' }], selectedMapLayersManual: true };
        const candidate = h.actions.getCandidates('true', { id: 'features', payload }).find(candidate => candidate.id === 'features')!;
        h.actions.execute(candidate.action, candidate.input);
        expect(h.run).toHaveBeenCalledExactlyOnceWith('true', { selectedMapLayers: payload.selectedMapLayers, selectedMapLayersManual: true });
    });

    it('captures the UI history scope before reorder and rejects a removed saved view', () => {
        const h = fixture();
        h.owners.viewSettings.importViews(['a', 'b']);
        const panel = Object.create(OmnibarComponent.prototype) as OmnibarComponent;
        panel.featureSearch = h.owners.searchService;
        const target = h.actions.getCandidates('true').find(candidate => candidate.id === 'features')!;
        const entry = panel['historyEntryForTarget']({ ...target, payload: { selectedViewIndices: [1] } }, 'true')!;
        expect(entry.payload).toEqual({ selectedViewIds: ['b'] });
        h.owners.viewSettings.retainViews([1, 0], new Map());
        const replay = h.actions.getCandidates(entry.input, { id: entry.actionId, payload: entry.payload }).find(candidate => candidate.id === 'features')!;
        h.actions.execute(replay.action, replay.input);
        expect(h.run).toHaveBeenCalledWith('true', { selectedViewIndices: [0] });
        h.owners.viewSettings.retainViews([1], new Map());
        expect(() => h.actions.execute(replay.action, replay.input)).toThrow('no longer available');
    });

    it('resolves explicit omnibar history against stable view identities after reorder', () => {
        const h = fixture();
        h.owners.viewSettings.importViews(['first', 'second']);
        const legacy = h.actions.getCandidates('true', { id: 'features', payload: { selectedViewIndices: [0] } }).find(candidate => candidate.id === 'features')!;
        expect(legacy.payload).toEqual({ selectedViewIds: ['first'] });
        h.owners.viewSettings.retainViews([1, 0], new Map());
        const replay = h.actions.getCandidates('true', { id: 'features', payload: legacy.payload }).find(candidate => candidate.id === 'features')!;
        h.actions.execute(replay.action, replay.input);
        expect(h.run).toHaveBeenCalledWith('true', { selectedViewIndices: [1] });
        h.owners.viewSettings.retainViews([0], new Map());
        expect(() => h.actions.execute(replay.action, replay.input)).toThrow('no longer available');
    });

    it('keeps source-data parsing, native feature jumps and configured providers executable', async () => {
        const h = fixture();
        const source = vi.fn();
        h.menu.customTileAndMapId.subscribe(source);
        const tile = String(coreLib.getTileIdFromPosition(11, 48, 13));
        const sourceChoice = h.actions.getCandidates(tile).find(candidate => candidate.id === 'source-data')!;
        await h.actions.execute(sourceChoice.action, sourceChoice.input);
        expect(source).toHaveBeenCalledWith([tile, '']);

        h.parser.filterFeatureJumpTargets.mockReturnValue([{ id: 'Road.id:1', name: 'Road', idParts: [{ key: 'id', value: 1 }], maps: ['Map'], error: null }] as never);
        const feature = vi.spyOn(h.jumps, 'highlightByJumpTarget').mockResolvedValue(undefined);
        const featureChoice = h.actions.getCandidates('Road.1').find(candidate => candidate.id === 'fj:Road.id:1')!;
        await h.actions.execute(featureChoice.action, featureChoice.input);
        expect(feature).toHaveBeenCalledOnce();

        const plugin = vi.fn(() => [1, 2]);
        h.jumps.extJumpTargets = [{
            id: 'plugin:route', name: 'Route', label: 'Route provider', icon: 'pi-map', color: 'green', enabled: true,
            validate: value => value === 'route', jump: plugin
        }];
        const payload = { route: 'saved' };
        const pluginChoice = h.actions.getCandidates('route', { id: 'plugin:route', payload }).find(candidate => candidate.id === 'plugin:route')!;
        await h.actions.execute(pluginChoice.action, pluginChoice.input);
        expect(plugin).toHaveBeenCalledWith('route', payload);
        h.jumps.extJumpTargets = [];
        await expect(h.actions.execute(pluginChoice.action, pluginChoice.input)).rejects.toThrow('no longer available');
    });

    it('returns asynchronous feature and plugin failures through the common dispatcher', async () => {
        const h = fixture();
        h.parser.filterFeatureJumpTargets.mockReturnValue([{ id: 'Road.id:1', name: 'Road', idParts: [{ key: 'id', value: 1 }], maps: ['Map'], error: null }] as never);
        vi.spyOn(h.jumps, 'highlightByJumpTarget').mockRejectedValue(new Error('locate response rejected'));
        const feature = h.actions.getCandidates('Road.1').find(candidate => candidate.id === 'fj:Road.id:1')!;
        await expect(h.actions.execute(feature.action, feature.input)).rejects.toThrow('locate response rejected');
        h.jumps.extJumpTargets = [{
            id: 'plugin:async', name: 'Async provider', label: 'Async provider', icon: 'pi-map', color: 'green', enabled: true,
            validate: () => true, execute: async () => { throw new Error('plugin request rejected'); }
        }];
        const plugin = h.actions.getCandidates('route').find(candidate => candidate.id === 'plugin:async')!;
        await expect(h.actions.execute(plugin.action, plugin.input)).rejects.toThrow('plugin request rejected');
    });

    it.each(['network', 'HTTP'] as const)('rejects a failed %s locate request through the common dispatcher', async kind => {
        const h = fixture();
        h.parser.filterFeatureJumpTargets.mockReturnValue([{
            id: 'Road.id:1', name: 'Road', idParts: [{ key: 'id', value: 1 }], maps: ['Map'], error: null
        }] as never);
        const fetch = vi.spyOn(globalThis, 'fetch');
        if (kind === 'network') fetch.mockRejectedValue(new Error('locate network request failed'));
        else fetch.mockResolvedValue(new Response('Unavailable', { status: 503 }));

        const feature = h.actions.getCandidates('Road.1').find(candidate => candidate.id === 'fj:Road.id:1')!;
        await expect(h.actions.execute(feature.action, feature.input)).rejects.toThrow(
            kind === 'network' ? 'locate network request failed' : 'Could not locate feature (HTTP 503).'
        );
        expect(fetch).toHaveBeenCalledExactlyOnceWith('locate', expect.objectContaining({ method: 'POST' }));
        expect(h.owners.inspectionState.model.selection).toEqual([]);
        expect(h.moved).not.toHaveBeenCalled();
    });

    it('resolves async location and external-viewer choices on their actual owners', () => {
        const h = fixture();
        const match: LocationSearchMatch = { id: 'wof:1', name: 'Munich', providerId: 'mapget-offline', providerName: 'Offline', lonLat: [11.5, 48.1] };
        h.navigation.updateSuggestions('Munich', [match]);
        const navigate = vi.spyOn(h.navigation, 'navigate').mockImplementation(() => { });
        const location = h.actions.getCandidates('Munich').find(candidate => candidate.id === 'loc:mapget-offline:wof:1')!;
        h.actions.execute(location.action, location.input);
        expect(navigate).toHaveBeenCalledWith(location.id, match);
        h.navigation.updateSuggestions('Other', []);
        const saved = h.actions.getCandidates('Munich', { id: location.id, payload: match }).find(candidate => candidate.id === location.id)!;
        expect(saved.input).toMatchObject(location.input as object);
        const identityOnly = h.actions.getCandidates('Munich', { id: location.id }).find(candidate => candidate.id === location.id)!;
        expect(identityOnly).toBeDefined();

        const provider = { id: 'external:map', name: 'Other map', urlTemplate: 'https://example.test/map?lat={lat}&lon={lon}' };
        vi.spyOn(h.external, 'providers', 'get').mockReturnValue([provider]);
        const open = vi.spyOn(h.external, 'open').mockImplementation(() => { });
        const external = h.actions.getCandidates('48,11').find(candidate => candidate.id === provider.id)!;
        h.actions.execute(external.action, external.input);
        expect(open).toHaveBeenCalledWith(provider, { lat: 48, lon: 11, source: 'input' });
        expect(external.saveToHistory).toBe(true);
        expect(h.actions.getCandidates('').find(candidate => candidate.id === provider.id)?.saveToHistory).toBe(false);
    });

    it('offers recognizable close choices using the same MCP handler and rejects retired lifetimes', () => {
        const h = fixture();
        const panelId = h.owners.inspectionState.setSelection([{ featureId: 'Road.17', mapTileKey: 'Features:Map:Road:1' }])!;
        const candidate = h.actions.getCandidates('close road').find(candidate => candidate.action === 'viewer_close_inspection')!;
        expect(candidate.name).toContain('Road.17');
        expect(candidate.saveToHistory).toBe(false);
        expect(candidate.input).toEqual({ panelId, lifetime: h.owners.inspectionState.panelLifetime(panelId) });
        h.actions.execute('viewer_close_inspection', candidate.input);
        h.owners.inspectionState.setSelection([{ featureId: 'Road.18', mapTileKey: 'Features:Map:Road:1' }]);
        expect(() => h.actions.execute(candidate.action, candidate.input)).toThrow('no longer exists');
        expect(h.actions.getCandidates('close road', { id: candidate.id }).some(choice => choice.id === candidate.id)).toBe(false);
        expect(h.owners.inspectionState.model.selection[0].features[0].featureId).toBe('Road.18');
    });

    it('exports public actions only and keeps runtime plugin/location/provider data out of the artifact', () => {
        const catalog = viewerActionCatalog();
        expect(catalog.actions.map(action => action.name).sort()).toEqual(Object.keys(viewerActions).sort());
        expect(catalog.actions.map(action => String(action.name))).not.toContain('jump_coordinates');
        expect(JSON.stringify(catalog)).not.toContain('plugin:route');
    });
});
