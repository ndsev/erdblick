import type {Page} from '@playwright/test';
import {expect, test} from '../fixtures/test';
import {viewerActions} from '../../app/actions/viewer-action.contract';
import {appStateChannels, cameraViewStateSchema} from '../../app/shared/app-state-channel.contract';
import {enableMapLayer} from '../utils/ui-helpers';
import {mcpClient} from '../utils/mcp-client';
import {TEST_LAYER_NAMES, TEST_MAP_NAMES} from '../utils/test-params';

test.use({stateSnapshot: null});
test.skip(process.env['EB_MAPGET_MCP_LOCAL'] !== '1', 'Requires the native local MCP fixture, not a mocked relay');

const twoViews = '/?v2=1&n=2&m=1&f=0&sync=&lon=10,20&lat=40,50&alt=500,1000&h=0,0&p=-1,-1&r=0,0&px=0,0&py=0,0&pz=0,0&m2d=0,0&bg=~10,~10&l=';

/** Labels a real tab through the product UI, so discovery also proves WS registration/update. */
async function openViewer(page: Page, label: string, sync = false, origin?: string) {
    const path = sync ? twoViews.replace('sync=&', 'sync=pos&') : twoViews;
    await page.goto(origin ? new URL(path, origin).href : path);
    await page.getByTestId('viewer-action-status').click();
    await expect(page.getByTestId('viewer-action-details')).toContainText('MCP controls ready');
    await page.getByLabel('Tab label', {exact: true}).fill(label);
    await page.getByLabel('Tab label', {exact: true}).press('Tab');
}

test('native MCP controls the selected live tab/view, retires stale UUIDs, and preserves map interaction', async ({page, context, request}) => {
    const mcp = mcpClient(request);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const discovery = await mcp.rpc('tools/list');
    expect(discovery.response.ok()).toBe(true);
    expect(discovery.message.result.tools.map((tool: {name: string}) => tool.name).filter((name: string) => name.startsWith('viewer_')).sort())
        .toEqual([...Object.keys(viewerActions), 'viewer_list_sessions'].sort());
    await openViewer(page, 'first-native-tab');
    const second = await context.newPage();
    try {
        const secondOrigin = new URL(page.url());
        secondOrigin.hostname = secondOrigin.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
        await openViewer(second, 'second-native-tab', true, secondOrigin.origin);
        await expect.poll(async () => (await mcp.sessions()).map(tab => tab.label).sort())
            .toEqual(['first-native-tab', 'second-native-tab']);
        const sessions = await mcp.sessions();
        const firstId = sessions.find(tab => tab.label === 'first-native-tab')!.clientId;
        const secondId = sessions.find(tab => tab.label === 'second-native-tab')!.clientId;
        expect(firstId).not.toEqual(secondId);
        const targets = [{channel: 'view.camera', viewIndex: 0}, {channel: 'view.camera', viewIndex: 1}];
        async function read(clientId: string) {
            const result = await mcp.call('viewer_get_app_state', {clientId, targets});
            expect(result.isError).not.toBe(true);
            return viewerActions.viewer_get_app_state.outputSchema.parse(result.structuredContent);
        }
        const description = await mcp.call('viewer_describe_app_state', {clientId: firstId});
        expect(description.isError).not.toBe(true);
        viewerActions.viewer_describe_app_state.outputSchema.parse(description.structuredContent);
        let before = await read(firstId);
        await expect.poll(async () => {
            before = await read(firstId);
            return before.values.every(value => 'value' in value);
        }).toBe(true);
        const otherBefore = await read(secondId);
        const value = {destination: {lon: 11.5374, lat: 48.1584, alt: 700}, orientation: {heading: 0, pitch: -1, roll: 0}, position: [0, 0, 0]};
        const result = await mcp.call('viewer_set_app_state', {
            clientId: firstId, target: targets[1], value, viewLayoutRevision: before.viewLayoutRevision
        });
        expect(result.isError).not.toBe(true);
        const applied = viewerActions.viewer_set_app_state.outputSchema.parse(result.structuredContent);
        expect(applied).toMatchObject({status: 'applied', focusedView: 1, affectedViews: [1], changed: true});
        expect(cameraViewStateSchema.parse(applied.value).destination.lon).toBeCloseTo(value.destination.lon, 5);
        expect((await read(firstId)).values[0]).toEqual(before.values[0]);
        expect((await read(secondId)).values).toEqual(otherBefore.values);
        await expect(page.getByTestId('viewer-action-details').getByRole('listitem').filter({hasText: 'viewer_set_app_state'}))
            .toContainText('applied');

        const synced = await mcp.call('viewer_set_app_state', {
            clientId: secondId, target: targets[1], value, viewLayoutRevision: otherBefore.viewLayoutRevision
        });
        expect(synced.isError).not.toBe(true);
        expect(synced.structuredContent.affectedViews.sort()).toEqual([0, 1]);

        // Navigation closes the old interactive connection; no target is silently rebound.
        await page.reload();
        await expect.poll(async () => (await mcp.sessions()).some(tab => tab.clientId === firstId)).toBe(false);
        const stale = await mcp.call('viewer_get_app_state', {clientId: firstId, targets});
        expect(stale.isError).toBe(true);
        await expect.poll(async () => (await mcp.sessions()).length).toBe(2);
        const replacement = (await mcp.sessions()).find(tab => tab.clientId !== secondId)!;
        expect(replacement.clientId).not.toBe(firstId);

        // Exercise a human camera gesture after remote control, not just a canvas screenshot.
        await page.bringToFront();
        const canvas = page.locator('#mapViewContainer-0 canvas').first();
        await expect(canvas).toBeVisible();
        const cameraBefore = await read(replacement.clientId);
        const box = (await canvas.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, {steps: 8});
        const duringGesture = await mcp.call('viewer_set_app_state', {
            clientId: replacement.clientId, target: targets[0], value,
            viewLayoutRevision: cameraBefore.viewLayoutRevision
        });
        expect(duringGesture.isError).toBe(true);
        expect(duringGesture.structuredContent.error).toMatchObject({code: 'busy', outcome: 'not_applied'});
        await page.mouse.up();
        await expect.poll(async () => (await read(replacement.clientId)).values[0]).not.toEqual(cameraBefore.values[0]);

        // The same connection must still deliver/render real subsets alongside controls.
        const enableLayer = enableMapLayer(page, TEST_MAP_NAMES[0], TEST_LAYER_NAMES[0]);
        expect((await mcp.call('viewer_get_app_state', {clientId: replacement.clientId})).isError).not.toBe(true);
        await enableLayer;
        await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions))
            .toBeGreaterThan(0);
        expect(await page.evaluate(() => window.ebDebug!.subsetRenderQueue().failed)).toBe(0);
        expect((await mcp.call('viewer_get_app_state', {clientId: replacement.clientId})).isError).not.toBe(true);
        expect(errors).toEqual([]);
    } finally {
        await second.close();
    }
    await expect.poll(async () => (await mcp.sessions()).length).toBe(1);
});

test('native MCP reads and operates UI controls and resizes sidebar, dock and split views in place', async ({page, request}) => {
    const mcp = mcpClient(request);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await openViewer(page, 'ui-actions');
    const clientId = (await mcp.sessions()).find(tab => tab.label === 'ui-actions')!.clientId;
    async function call(name: string, args: Record<string, unknown>) {
        const result = await mcp.call(name, {clientId, ...args});
        expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
        return result.structuredContent;
    }
    async function snapshot() {
        return viewerActions.viewer_take_snapshot.outputSchema.parse(await call('viewer_take_snapshot', {limit: 300}));
    }
    let ui = await snapshot();
    const label = ui.elements.find(element => element.name === 'Tab label' && element.tag === 'input')!;
    expect(label).toBeDefined();
    const details = await call('viewer_get_element', {uid: label.uid, styles: ['font-size', 'color']});
    expect(details.element.value).toBe('ui-actions');
    await call('viewer_fill', {uid: label.uid, value: 'ui-actions-renamed'});
    await expect(page.getByLabel('Tab label', {exact: true})).toHaveValue('ui-actions-renamed');
    await expect.poll(async () => (await mcp.sessions()).some(tab => tab.label === 'ui-actions-renamed')).toBe(true);
    ui = await snapshot();
    const stale = await mcp.call('viewer_fill', {clientId, uid: label.uid, value: 'must-not-apply'});
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.structuredContent)).toContain('stale_element');

    const statusHost = ui.elements.find(element => element.testId === 'viewer-action-status')!;
    const statusButton = ui.elements.find(element => element.parentUid === statusHost.uid && element.tag === 'button')!;
    await call('viewer_click', {uid: statusButton.uid});
    await expect(page.getByTestId('viewer-action-details')).not.toBeVisible();

    const canvas = await page.locator('#mapViewContainer-0 canvas').first().elementHandle();
    ui = await snapshot();
    const split = ui.elements.find(element => element.resize?.kind === 'split')!;
    expect(await call('viewer_resize', {uid: split.uid, size: {panelSizes: [65, 35]}}))
        .toMatchObject({status: 'applied', element: {resize: {panelSizes: [65, 35]}}});
    await expect.poll(async () => {
        const left = (await page.locator('#mapViewContainer-0').boundingBox())!;
        const right = (await page.locator('#mapViewContainer-1').boundingBox())!;
        return left.width / (left.width + right.width);
    }).toBeCloseTo(0.65, 2);
    expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);

    ui = await snapshot();
    await call('viewer_click', {uid: ui.elements.find(element => element.testId === 'maps-toggle')!.uid});
    await expect(page.getByTestId('map-layer-dialog').locator('.p-dialog')).toBeVisible();
    ui = await snapshot();
    const sidebar = ui.elements.find(element => element.resize?.kind === 'dialog')!;
    const resized = await call('viewer_resize', {uid: sidebar.uid, size: {widthPx: 520, heightPx: 650}});
    expect(resized.element.bounds.width).toBeCloseTo(520, 0);
    await expect.poll(async () => (await page.getByTestId('map-layer-dialog').locator('.p-dialog').boundingBox())!.width).toBeCloseTo(520, 0);
    ui = await snapshot();
    await call('viewer_fill', {uid: ui.elements.find(element => element.testId === 'map-filter-input')!.uid, value: 'nonexistent-map'});
    await expect(page.getByTestId('map-filter-input')).toHaveValue('nonexistent-map');
    await call('viewer_scroll', {uid: (await snapshot()).rootUid, position: {left: 0, top: 0}});
    ui = await snapshot();
    await call('viewer_click', {uid: ui.elements.find(element => element.testId === 'maps-toggle')!.uid});

    ui = await snapshot();
    await call('viewer_click', {uid: ui.elements.find(element => element.testId === 'dock-toggle')!.uid});
    ui = await snapshot();
    const dock = ui.elements.find(element => element.resize?.kind === 'dock')!;
    expect(await call('viewer_resize', {uid: dock.uid, size: {widthPx: 480}}))
        .toMatchObject({status: 'applied', element: {bounds: {width: 480}}});
    await expect(page.getByTestId('inspection-dock')).toHaveCSS('width', '480px');
    expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);

    // Local layout persistence is independent of shareable camera URL state.
    await page.reload();
    await expect(page.getByTestId('inspection-dock')).toHaveCSS('width', '480px');
    await expect.poll(async () => {
        const left = (await page.locator('#mapViewContainer-0').boundingBox())!;
        const right = (await page.locator('#mapViewContainer-1').boundingBox())!;
        return left.width / (left.width + right.width);
    }).toBeCloseTo(0.65, 2);
    expect(errors).toEqual([]);
});

test('native local MCP rejects untrusted origins/hosts and requires an explicit browser target', async ({request}) => {
    const mcp = mcpClient(request);
    for (const headers of [{Origin: 'https://untrusted.invalid'}, {Host: 'untrusted.invalid'}]) {
        const reply = await mcp.rpc('tools/list', {}, headers);
        expect(reply.response.status()).toBe(403);
    }
    const missingTarget = await mcp.rpc('tools/call', {name: 'viewer_get_app_state', arguments: {}});
    expect(missingTarget.response.status()).toBe(400);
    expect((await missingTarget.response.json()).error.code).toBe(-32602);
});

test('native MCP starts, styles, exports and inspects a real search through the ordinary viewer services', async ({page, request}, testInfo) => {
    const mcp = mcpClient(request);
    await page.unroute('**/locate'); // This path must exercise native canonical-ID resolution, not the synthetic UI fixture.
    await openViewer(page, 'search-workbench');
    await expect.poll(async () => (await mcp.sessions()).length).toBe(1);
    const clientId = (await mcp.sessions())[0].clientId;
    /** Validates the browser and native result schemas for every operation. */
    async function call<Name extends keyof typeof viewerActions>(name: Name, args: object) {
        const result = await mcp.call(name, {clientId, ...args});
        expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
        return viewerActions[name].outputSchema.parse(result.structuredContent);
    }
    const initial = viewerActions.viewer_get_app_state.outputSchema.parse(await call('viewer_get_app_state', {}));
    const viewLayoutRevision = initial.viewLayoutRevision;
    const layer = {mapId: TEST_MAP_NAMES[0], layerId: TEST_LAYER_NAMES[0]};
    await call('viewer_set_app_state', {target: {channel: 'view.layer', viewIndex: 0, ...layer},
        value: {visible: true, level: 13, autoLevel: false}, viewLayoutRevision});
    expect(await call('viewer_get_catalog', {kind: 'layers', viewIndex: 0, ...layer})).toMatchObject({items: [{visible: true, available: true}]});
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions)).toBeGreaterThan(0);
    // Visibility must change rendered geometry, not only the persisted/catalog flag.
    const styleCatalog = viewerActions.viewer_get_catalog.outputSchema.parse(await call('viewer_get_catalog', {kind: 'styles', limit: 100}));
    const visibleStyles = styleCatalog.items.filter(style => style.visible === true);
    expect(visibleStyles.length).toBeGreaterThan(0);
    for (const style of visibleStyles) await call('viewer_edit_style', {operation: 'visibility', styleId: style.id, visible: false});
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions)).toBe(0);
    for (const style of visibleStyles) await call('viewer_edit_style', {operation: 'visibility', styleId: style.id, visible: true});
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions)).toBeGreaterThan(0);
    const invalidRegex = await call('viewer_validate_style', {source: `name: Regex recovery
version: 2
rules:
  - scope: attribute
    attribute-type: '*SPEED*'
    geometry: line
`});
    expect(invalidRegex).toMatchObject({valid: false, runtimeVerified: false});
    expect(invalidRegex.issues).toEqual(expect.arrayContaining([expect.objectContaining({property: 'attribute-type'})]));
    const started = viewerActions.viewer_start_search.outputSchema.parse(await call('viewer_start_search', {
        // GridDataSource does not advertise zoomLevels; there is no automatic search-level choice.
        query: 'true', scope: 'feature', mapLayers: [layer], viewIndices: [0], tileLevels: [13], autoUpdate: false, viewLayoutRevision
    }));
    const searchId = started.searchId;
    let status = viewerActions.viewer_get_search.outputSchema.parse(await call('viewer_get_search', {searchId}));
    await expect.poll(async () => {
        status = viewerActions.viewer_get_search.outputSchema.parse(await call('viewer_get_search', {searchId}));
        return status.status.resultCount;
    }).toBeGreaterThan(0);
    expect(status.settings.autoUpdate).toBe(false);
    expect(status.schemaAnalysis).toMatchObject({status: 'ready', concreteScope: 'feature', normalizedQuery: 'true'});
    const browserDiagnostics = viewerActions.viewer_get_diagnostics.outputSchema.parse(await call('viewer_get_diagnostics', {
        sections: ['workers', 'gpu']
    }));
    expect(browserDiagnostics.executionContext).toBe('browser');
    expect(browserDiagnostics.metrics.some(metric => metric.name === 'latestWasmMs')).toBe(true);
    expect(browserDiagnostics.metrics.some(metric => metric.name === 'frameIntervalP90Ms')).toBe(true);
    expect(browserDiagnostics.metrics.some(metric => metric.name === 'latestNativeMs')).toBe(false);
    // A focused edit must survive native catalog validation and preserve unrelated source.
    const patchSource = 'name: MCP patch regression\nversion: 2\nrules:\n  - geometry: line\n    color: "#1188ff"\n    width: 2\n';
    const patchStyle = viewerActions.viewer_edit_style.outputSchema.parse(await call('viewer_edit_style', {
        operation: 'create', source: patchSource, visible: true
    }));
    const rejectedPatch = await mcp.call('viewer_edit_style', {clientId, operation: 'patch', styleId: patchStyle.styleId,
        edits: [{find: 'width: 2', replace: 'width: 6'}, {find: 'absent fragment', replace: 'replacement'}]});
    expect(rejectedPatch.isError).toBe(true);
    expect(await call('viewer_get_style', {styleId: patchStyle.styleId})).toMatchObject({source: patchSource});
    const invalidPatch = await mcp.call('viewer_edit_style', {clientId, operation: 'patch', styleId: patchStyle.styleId,
        edits: [{find: 'width: 2', replace: 'width: banana'}]});
    expect(invalidPatch.isError).toBe(true);
    expect(invalidPatch.structuredContent).toMatchObject({error: {
        code: 'invalid_arguments', reason: 'style_validation_failed', outcome: 'not_applied', message: expect.stringContaining('bad conversion')
    }});
    expect(invalidPatch.structuredContent.error.message).toContain('"rulePath":"rules[0]"');
    expect(invalidPatch.structuredContent.error.message).toContain('line 6, column 12');
    expect(await call('viewer_get_style', {styleId: patchStyle.styleId})).toMatchObject({source: patchSource});
    expect(await call('viewer_edit_style', {operation: 'patch', styleId: patchStyle.styleId,
        edits: [{find: 'width: 2', replace: 'width: 6'}]})).toMatchObject({changed: true, editCount: 1});
    expect(await call('viewer_get_style', {styleId: patchStyle.styleId})).toMatchObject({source: patchSource.replace('width: 2', 'width: 6')});
    await call('viewer_edit_style', {operation: 'delete', styleId: patchStyle.styleId});
    await call('viewer_set_search', {searchId, viewLayoutRevision, settings: {pinColor: '#00ccff',
        searchStyleRules: [{geometry: ['line'], filter: [], color: {mode: 'solid', color: '#00ccff'}, width: 5}],
        renderStrategy: {showHighFiGeometry: true}}});
    await call('viewer_set_search', {searchId, viewLayoutRevision, settings: {renderStrategy: {showHighFiResultDots: false}}});
    const patched = viewerActions.viewer_get_search.outputSchema.parse(await call('viewer_get_search', {searchId}));
    expect(patched.settings).toMatchObject({...status.settings, pinColor: '#00ccff',
        searchStyleRules: [{geometry: ['line'], filter: [], color: {mode: 'solid', color: '#00ccff'}, width: 5}],
        renderStrategy: {...status.settings.renderStrategy, showHighFiGeometry: true, showHighFiResultDots: false}});
    const addressBeforeShare = page.url();
    const shared = viewerActions.viewer_get_share_link.outputSchema.parse(await call('viewer_get_share_link', {}));
    expect(shared.localOnly).toBe(true);
    expect(shared.localSearchIds).toContain(searchId);
    expect(new URL(shared.url).searchParams.size).toBeGreaterThan(0);
    expect(page.url()).toBe(addressBeforeShare);
    await call('viewer_control_search', {searchId, operation: 'pause'});
    await call('viewer_control_search', {searchId, operation: 'resume'});
    await call('viewer_control_search', {searchId, operation: 'refresh'});
    await expect.poll(async () => viewerActions.viewer_get_search.outputSchema.parse(await call('viewer_get_search', {searchId})).status.resultCount).toBeGreaterThan(0);
    const slice = viewerActions.viewer_get_search_results.outputSchema.parse(await call('viewer_get_search_results', {searchId, limit: 1}));
    const feature = slice.results[0];
    expect(feature).toBeDefined();
    const exported = viewerActions.viewer_export_search.outputSchema.parse(await call('viewer_export_search', {searchId, include: 'both', limit: 1}));
    expect(JSON.parse(exported.content).configuration.pinColor).toBe('#00ccff');
    const inspected = viewerActions.viewer_inspect.outputSchema.parse(await call('viewer_inspect', {
        features: [{mapId: feature.mapId, layerId: feature.layerId, featureId: feature.featureId}], lock: true, newPanel: true, color: '#aa33cc'
    }));
    expect(inspected.complete).toBe(true);
    const panelId = inspected.panelIds[0];
    await expect.poll(async () => {
        const result = viewerActions.viewer_get_app_state.outputSchema.parse(await call('viewer_get_app_state', {targets: [{channel: 'app.selections', panelId}]}));
        return result.values;
    }).toMatchObject([{value: [{loading: false}]}]);
    const relationData = await mcp.call('mapget_extract_features', {...layer, featureIds: [feature.featureId], expressions: ['relations']});
    expect(relationData.isError).not.toBe(true);
    expect(relationData.structuredContent.complete).toBe(true);
    expect(relationData.structuredContent.items[0].values[0][0][0].name).toBe('startIntersection');
    const relationInspection = viewerActions.viewer_inspect.outputSchema.parse(await call('viewer_inspect', {
        features: [{mapTileKey: feature.mapTileKey, featureId: feature.featureId, relationIndex: 0}], newPanel: true
    }));
    expect(relationInspection.features).toEqual([{mapTileKey: feature.mapTileKey, featureId: `${feature.featureId}:relation#0`}]);
    await call('viewer_close_inspection', {panelId: relationInspection.panelIds[0]});
    await call('viewer_navigate', {viewIndex: 0, viewLayoutRevision, target: {features: [{mapTileKey: feature.mapTileKey, featureId: feature.featureId}]}});
    // Exercise the same persisted resize callbacks as floating and stacked inspection UI.
    const panelTarget = {channel: 'inspection.panel', panelId};
    const panelState = viewerActions.viewer_get_app_state.outputSchema.parse(await call('viewer_get_app_state', {targets: [panelTarget]}));
    const presentation = appStateChannels['inspection.panel'].valueSchema.parse(panelState.values[0].value);
    expect(presentation.color).toBe('#aa33cc');
    async function layoutTarget(kind: 'dialog' | 'panel', id: number) {
        let offset = 0;
        for (;;) {
            const snapshot = viewerActions.viewer_take_snapshot.outputSchema.parse(await call('viewer_take_snapshot', {offset, limit: 300}));
            const target = snapshot.elements.find(element => element.resize?.kind === kind && element.resize.layoutId === `inspection:${id}`);
            if (target) return target;
            expect(snapshot.nextOffset, `Missing ${kind} target for inspection ${id}`).toBeDefined();
            offset = snapshot.nextOffset!;
        }
    }
    await call('viewer_set_app_state', {target: panelTarget, value: {...presentation, undocked: true}});
    const floating = page.locator('inspection-panel-dialog .p-dialog').first();
    await expect(floating).toBeVisible();
    const dialog = await layoutTarget('dialog', panelId);
    const floatingSize = viewerActions.viewer_resize.outputSchema.parse(await call('viewer_resize', {uid: dialog.uid, size: {widthPx: 600, heightPx: 500}}));
    expect(floatingSize.element.bounds.width).toBeCloseTo(600, 0);
    await expect.poll(async () => (await floating.boundingBox())!.width).toBeCloseTo(600, 0);
    await call('viewer_set_app_state', {target: panelTarget, value: {...presentation, undocked: false}});
    await expect(floating).not.toBeVisible();
    await call('viewer_set_app_state', {target: panelTarget, value: {...presentation, undocked: true}});
    await expect(floating).toBeVisible();
    await expect.poll(async () => (await floating.boundingBox())!.width).toBeCloseTo(600, 0);
    await call('viewer_set_app_state', {target: panelTarget, value: {...presentation, undocked: false}});
    const duplicate = viewerActions.viewer_inspect.outputSchema.parse(await call('viewer_inspect', {
        features: [{mapId: feature.mapId, layerId: feature.layerId, featureId: feature.featureId}], newPanel: true, lock: true
    }));
    const otherPanelId = duplicate.panelIds.find(id => id !== panelId)!;
    expect(otherPanelId).toBeDefined();
    await call('viewer_set_app_state', {target: {channel: 'inspection.panel', panelId: otherPanelId}, value: {...presentation, undocked: false}});
    await expect(page.getByTestId('inspection-panel')).toHaveCount(2);
    const stacked = await layoutTarget('panel', panelId);
    expect(stacked.resize!.dimensions).toEqual(['heightPx']);
    const bodySize = viewerActions.viewer_resize.outputSchema.parse(await call('viewer_resize', {uid: stacked.uid, size: {heightPx: 320}}));
    expect(bodySize.element.bounds.height).toBeCloseTo(320, 0);
    const panelContent = page.getByTestId('inspection-panel').first().getByTestId('dock-panel-content');
    await expect.poll(async () => (await panelContent.boundingBox())!.height).toBeCloseTo(320, 0);
    await call('viewer_set_app_state', {target: panelTarget, value: {...presentation, undocked: true}});
    await expect(floating).toBeVisible();
    await call('viewer_set_app_state', {target: panelTarget, value: {...presentation, undocked: false}});
    await expect.poll(async () => (await panelContent.boundingBox())!.height).toBeCloseTo(320, 0);
    await call('viewer_close_inspection', {panelId: otherPanelId});
    // Capture actual panels and both WebGL views through the native MCP image boundary, not a mocked canvas.
    const inspection = page.getByTestId('inspection-panel').first();
    await expect(inspection).toBeVisible();
    const panelBox = (await inspection.boundingBox())!;
    const beforeScreenshot = await page.screenshot({animations: 'disabled'});
    const captureStarted = Date.now();
    const screenshot = await mcp.call('viewer_screenshot', {clientId, maxWidth: 1280, maxHeight: 960, viewLayoutRevision});
    const captureElapsedMs = Date.now() - captureStarted;
    expect(screenshot.isError, JSON.stringify(screenshot.structuredContent)).not.toBe(true);
    const metadata = viewerActions.viewer_screenshot.outputSchema.shape.metadata.parse(screenshot.structuredContent);
    expect(metadata).toMatchObject({scope: 'application-viewport', viewLayoutRevision, readiness: {status: 'unknown'}});
    expect(metadata.width).toBeLessThanOrEqual(1280);
    expect(metadata.height).toBeLessThanOrEqual(960);
    const image = screenshot.content.find((item: {type: string}) => item.type === 'image');
    expect(image).toMatchObject({type: 'image', mimeType: 'image/jpeg'});
    expect(image.data.length).toBeLessThanOrEqual(240000);
    expect(screenshot.structuredContent).not.toHaveProperty('image');
    expect(screenshot.content.filter((item: {type: string}) => item.type === 'text')
        .every((item: {text: string}) => !item.text.includes(image.data))).toBe(true);
    await testInfo.attach('application-screenshot-mcp', {body: Buffer.from(image.data, 'base64'), contentType: 'image/jpeg'});
    await testInfo.attach('application-screenshot-browser-reference', {body: beforeScreenshot, contentType: 'image/png'});
    await testInfo.attach('application-screenshot-metadata', {body: JSON.stringify({...metadata, captureElapsedMs}), contentType: 'application/json'});
    const comparison = await page.evaluate(async ({actual, expected, panelBox}) => {
        async function pixels(url: string, panelOnly = false) {
            const image = new Image();
            image.src = url;
            await image.decode();
            const canvas = document.createElement('canvas');
            // Compare large-scale layout/colors; DOM serialization and lossy JPEG are not pixel-identical.
            canvas.width = 64; canvas.height = 40;
            const ctx = canvas.getContext('2d')!;
            if (panelOnly) {
                const scaleX = image.width / document.documentElement.clientWidth;
                const scaleY = image.height / document.documentElement.clientHeight;
                ctx.drawImage(image, panelBox.x * scaleX, panelBox.y * scaleY, panelBox.width * scaleX, panelBox.height * scaleY, 0, 0, 64, 40);
            } else ctx.drawImage(image, 0, 0, 64, 40);
            return ctx.getImageData(0, 0, 64, 40).data;
        }
        const a = await pixels(actual), b = await pixels(expected);
        const bands = [0, 1, 2, 3].map(band => {
            let error = 0;
            for (let y = band * 10; y < (band + 1) * 10; y++) for (let x = 0; x < 64; x++) {
                for (let channel = 0; channel < 3; channel++) error += Math.abs(a[(y * 64 + x) * 4 + channel] - b[(y * 64 + x) * 4 + channel]);
            }
            return error / (64 * 10 * 3);
        });
        const panelA = await pixels(actual, true), panelB = await pixels(expected, true);
        let panelError = 0;
        for (let pixel = 0; pixel < 64 * 40; ++pixel) for (let channel = 0; channel < 3; ++channel) {
            panelError += Math.abs(panelA[pixel * 4 + channel] - panelB[pixel * 4 + channel]);
        }
        return [...bands, panelError / (64 * 40 * 3)];
    }, {actual: `data:image/jpeg;base64,${image.data}`, expected: `data:image/png;base64,${beforeScreenshot.toString('base64')}`, panelBox});
    expect(comparison.every(error => error < 30), `Viewport band color errors: ${comparison}`).toBe(true);
    await call('viewer_close_inspection', {panelId});
    await call('viewer_control_search', {searchId, operation: 'rerun', query: 'true'});
    await call('viewer_control_search', {searchId, operation: 'stop'});
    await call('viewer_control_search', {searchId, operation: 'close'});
    expect(await call('viewer_get_app_state', {targets: [{channel: 'app.searches'}]})).toMatchObject({values: [{value: []}]});
});
