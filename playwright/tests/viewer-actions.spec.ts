import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Page, WebSocketRoute} from '@playwright/test';
import {expect, test} from '../fixtures/test';
import type {ViewerActionClientMessage} from '../../app/actions/viewer-action-relay.contract';
import {viewerResult, availableValue, type ViewerActionName} from '../utils/viewer-catalog';
import {cameraViewStateSchema} from '../../app/mapview/map-view.service.declarations';

test.use({stateSnapshot: null});

/** Browser-adapter fixture only: native MCP authentication/relay require separate backend integration tests. */
async function browserActions(page: Page, mismatch = false) {
    const catalog = JSON.parse(readFileSync('static/browser/web-mcp-actions.json', 'utf8'));
    const clientId = randomUUID();
    const messages: ViewerActionClientMessage[] = [];
    const connections: WebSocketRoute[] = [];
    let protocol: number[] = [];
    let sequence = 0;
    // State controls must work in a real viewer with no selected map or loaded tiles.
    await page.route('**/sources?*', route => route.fulfill({json: []}));
    await page.route('**/mcp/info', route => route.fulfill({json: {
        enabled: true, endpoint: 'http://localhost:9000/mcp', authentication: 'local', scopes: [],
        catalogId: mismatch ? `sha256:${'a'.repeat(64)}` : catalog.catalogId
    }}));
    await page.route('**/interactive/payload?*', async route => {
        await new Promise(resolve => setTimeout(resolve, 100));
        await route.fulfill({status: 204});
    });

    /** Encodes the same VTLV framing as the existing interactive connection. */
    function frame(type: number, value: object): Buffer {
        const body = Buffer.from(JSON.stringify(value));
        const bytes = Buffer.alloc(11 + body.length);
        protocol.forEach((part, index) => bytes.writeUInt16LE(part, index * 2));
        bytes[6] = type;
        bytes.writeUInt32LE(body.length, 7);
        body.copy(bytes, 11);
        return bytes;
    }

    await page.routeWebSocket('**/interactive', socket => {
        connections.push(socket);
        socket.onMessage(raw => {
            const message = JSON.parse(raw.toString()) as ViewerActionClientMessage;
            if (!message.type?.startsWith('mapget.actions.')) return;
            messages.push(message);
            if (message.type === 'mapget.actions.register' || message.type === 'mapget.actions.update') {
                socket.send(frame(9, {type: message.type === 'mapget.actions.register'
                    ? 'mapget.actions.registered' : 'mapget.actions.updated', version: 1, clientId, catalogId: catalog.catalogId}));
            }
        });
    });
    await page.goto('/?v2=1&n=2&vid=left,right&m=1&f=0&sync=&lon=10,20&lat=40,50&alt=500,1000&h=0,0&p=-1,-1&r=0,0&px=0,0&py=0,0&pz=0,0&m2d=0,0&bg=~10,~10&l=');
    await expect.poll(() => page.evaluate(() => !!window.ebDebug)).toBe(true);
    protocol = await page.evaluate(() => {
        const core = window.ebDebug!.coreLib();
        return [core.tileLayerStreamProtocolMajor(), core.tileLayerStreamProtocolMinor(), 0];
    });
    await expect.poll(() => connections.length).toBe(1);
    connections[0].send(frame(6, {type: 'mapget.tiles.request-context', requestId: 0, clientId}));
    if (!mismatch) await expect.poll(() => messages.some(message => message.type === 'mapget.actions.register')).toBe(true);

    /** Sends one typed call over the socket and waits for its own result, never invoking a service through a debug hook. */
    async function invoke(action: string, args: object) {
        const callId = `browser-${++sequence}`;
        connections[0].send(frame(9, {type: 'mapget.actions.invoke', version: 1, callId, action, arguments: args, timeoutMs: 30000}));
        await expect.poll(() => messages.some(message => message.type === 'mapget.actions.result' && message.callId === callId)).toBe(true);
        return messages.find(message => message.type === 'mapget.actions.result' && message.callId === callId) as Extract<ViewerActionClientMessage, {type: 'mapget.actions.result'}>;
    }
    return {invoke, messages, connections};
}

test('browser action adapter reads live views, moves only its target and updates activity without another click', async ({page, context}) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const first = await browserActions(page);
    const secondPage = await context.newPage();
    const second = await browserActions(secondPage);
    try {
        const targets = [{control: 'view.camera', viewId: 'left'}, {control: 'view.camera', viewId: 'right'}];
        /** Checks the result boundary as well as successful transport. */
        async function read(adapter: typeof first) {
            const reply = await adapter.invoke('viewer_get_controls', {targets});
            expect('error' in reply ? reply.error : undefined).toBeUndefined();
            return viewerResult('viewer_get_controls', 'result' in reply ? reply.result : undefined);
        }
        let before = await read(first);
        await expect.poll(async () => {
            before = await read(first);
            return before.values.every(value => 'value' in value);
        }).toBe(true);
        const otherBefore = await read(second);
        await page.bringToFront();
        await page.getByTestId('viewer-action-status').click();
        const details = page.getByTestId('viewer-action-details');
        await expect(details).toContainText('MCP controls ready');
        await expect(details.getByRole('group', {name: 'Copy Add-MCP-Command'})).toContainText('Copy Add-MCP-Command:');
        await expect(details.getByTestId('viewer-action-copy-codex')).toHaveText('Codex');
        await expect(details.getByTestId('viewer-action-copy-claude')).toHaveText('Claude');
        await expect(details.getByTestId('viewer-action-copy-copilot')).toHaveText('Copilot');
        await expect(details.getByRole('button', {name: 'Copy MCP URL', exact: true})).toHaveCount(0);

        const value = {destination: {lon: 11.5374, lat: 48.1584, alt: 700}, orientation: {heading: 0, pitch: -1, roll: 0}, position: [0, 0, 0]};
        const reply = await first.invoke('viewer_set_control', {target: targets[1], value});
        expect('error' in reply ? reply.error : undefined).toBeUndefined();
        const applied = viewerResult('viewer_set_control', 'result' in reply ? reply.result : undefined);
        expect(applied).toMatchObject({status: 'applied', changed: true, readiness: {status: 'unknown'}});
        expect(cameraViewStateSchema.parse(applied.value).destination.lon).toBeCloseTo(value.destination.lon, 5);
        await expect(details.getByRole('listitem').filter({hasText: 'viewer_set_control'})).toContainText('applied');
        const after = await read(first);
        expect(after.values[0]).toEqual(before.values[0]);
        expect((await read(second)).values).toEqual(otherBefore.values);
        expect(first.connections).toHaveLength(1);
        expect(second.connections).toHaveLength(1);

        await page.getByLabel('Tab label', {exact: true}).fill('Camera workbench');
        await page.getByLabel('Tab label', {exact: true}).press('Tab');
        await expect.poll(() => first.messages.some(message => message.type === 'mapget.actions.update' && message.label === 'Camera workbench')).toBe(true);
        const labelInput = page.getByLabel('Tab label', {exact: true});
        await expect(labelInput).toHaveAttribute('maxlength', '240');
        for (const [entered, expected] of [
            ['😀'.repeat(120), '😀'.repeat(120)],
            ['a'.repeat(119) + '😀x', 'a'.repeat(119) + '😀']
        ]) {
            await labelInput.fill(entered);
            await labelInput.press('Tab');
            await expect.poll(() => first.messages.some(message => message.type === 'mapget.actions.update' && message.label === expected)).toBe(true);
            await expect(labelInput).toHaveValue(expected);
        }
        expect(errors).toEqual([]);
    } finally {
        await secondPage.close();
    }
});

test('MCP activity turns green during pending work and gray after completion or stop without another click', async ({page}) => {
    const adapter = await browserActions(page);
    const status = page.getByTestId('viewer-action-status').getByRole('button');
    await expect(status).toHaveClass(/p-button-secondary/);
    for (const finish of ['response', 'stop'] as const) {
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        await page.route('**/locate', async route => {
            await pending;
            await route.fulfill({json: {responses: [[]]}});
        });
        const result = adapter.invoke('viewer_inspect', {features: [{mapId: 'TestMap', featureId: 'Way.1'}]});
        try {
            // No click or open popover is needed to publish action activity.
            await expect(status).toHaveClass(/p-button-success/, {timeout: 10000});
            if (finish === 'stop') {
                await status.click();
                await page.getByTestId('viewer-action-stop').getByRole('button').click();
            } else release();
            const reply = await result;
            expect('error' in reply ? reply.error.code : undefined).toBe(finish === 'stop' ? 'cancelled' : 'not_available');
            await expect(status).toHaveClass(/p-button-secondary/, {timeout: 10000});
        } finally {
            release();
        }
    }
});

for (const darkMode of ['off', 'on'] as const) {
    test.describe(`MCP controls with dark mode ${darkMode}`, () => {
        test.use({darkMode});
        test('spaces the status button, centers its arrow and keeps compact copy commands in one row', async ({page}, testInfo) => {
            await browserActions(page);
            const status = page.getByTestId('viewer-action-status').getByRole('button');
            await expect(status).toHaveClass(/p-button-secondary/);
            await expect(status).not.toHaveClass(/p-button-text/);
            await expect(status).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
            for (const width of [1600, 480, 360]) {
                await page.setViewportSize({width, height: 900});
                const statusBox = await status.boundingBox();
                const diagnosticsBox = await page.locator('diagnostics-indicator').boundingBox();
                expect(diagnosticsBox!.x - statusBox!.x - statusBox!.width).toBeGreaterThanOrEqual(8);
                // Native diagnostics button font metrics differ across engines. Keep
                // the MCP button centered with at least the indicator's clearance.
                expect(statusBox!.height).toBeLessThanOrEqual(diagnosticsBox!.height + 2);
                expect(Math.abs(statusBox!.y + statusBox!.height / 2 - diagnosticsBox!.y - diagnosticsBox!.height / 2)).toBeLessThan(1);
                await status.click({timeout: 10000});
                const details = page.getByTestId('viewer-action-details');
                const overlay = page.getByRole('dialog').filter({has: details});
                await expect(overlay).toBeVisible();
                await expect(overlay).toHaveCSS('transform', 'none', {timeout: 10000});
                // PrimeNG draws a zero-width CSS triangle with balanced borders/margin.
                // Its computed left therefore identifies the visible arrow tip.
                await expect.poll(() => overlay.evaluate(element => {
                    const button = document.querySelector('[data-testid="viewer-action-status"] button')!;
                    const target = button.getBoundingClientRect();
                    const arrow = getComputedStyle(element, '::before');
                    const tip = element.getBoundingClientRect().left + parseFloat(arrow.left);
                    return Math.abs(tip - target.left - target.width / 2);
                }), {timeout: 10000}).toBeLessThan(2);
                const overlayBox = await overlay.boundingBox();
                expect(overlayBox!.width).toBeLessThan(560);
                expect(overlayBox!.x).toBeGreaterThanOrEqual(0);
                expect(overlayBox!.x + overlayBox!.width).toBeLessThanOrEqual(width);
                const buttons = details.getByTestId(/^viewer-action-copy-/).getByRole('button');
                await expect(buttons).toHaveCount(3);
                await expect(buttons.last()).toBeVisible();
                const bounds = await buttons.evaluateAll(elements => elements.map(element => {
                    const {top, bottom, left, right} = element.getBoundingClientRect();
                    return {top, bottom, left, right};
                }));
                for (const box of bounds) {
                    expect(Math.abs(box.top - bounds[0].top)).toBeLessThan(1);
                    expect(Math.abs(box.bottom - bounds[0].bottom)).toBeLessThan(1);
                    expect(box.right - box.left).toBeGreaterThan(0);
                    expect(box.left).toBeGreaterThanOrEqual(0);
                    expect(box.right).toBeLessThanOrEqual(width);
                }
                const label = details.getByText('Copy Add-MCP-Command:', {exact: true});
                await expect(label).toBeVisible();
                if (width >= 480) {
                    const labelBox = await label.boundingBox();
                    expect(labelBox!.x + labelBox!.width).toBeLessThan(bounds[0].left);
                    expect(labelBox!.y).toBeGreaterThanOrEqual(bounds[0].top);
                    expect(labelBox!.y + labelBox!.height).toBeLessThanOrEqual(bounds[0].bottom);
                }
                await page.mouse.move(0, 0);
                const screenshot = testInfo.outputPath(`mcp-controls-${darkMode}-${width}.png`);
                await page.screenshot({path: screenshot});
                await testInfo.attach(`mcp-controls-${darkMode}-${width}`, {path: screenshot, contentType: 'image/png'});
                await status.click({timeout: 10000});
                await expect(details).toBeHidden();
            }
        });
    });
}

test('catalog mismatch disables agent controls without hiding the map or opening another socket', async ({page}) => {
    const adapter = await browserActions(page, true);
    await page.getByTestId('viewer-action-status').click();
    await expect(page.getByTestId('viewer-action-details')).toContainText('catalogs do not match');
    await expect(page.getByTestId('viewer-action-status').getByRole('button')).toHaveClass(/p-button-danger/);
    await expect(page.locator('#mapViewContainer-0 canvas').first()).toBeVisible();
    expect(adapter.messages).toEqual([]);
    expect(adapter.connections).toHaveLength(1);
});

test('browser actions share settings, view lifecycle, style editing and diagnostics with their real owners', async ({page}) => {
    const adapter = await browserActions(page);
    /** Exercises typed wire replies, not private service/debug methods. */
    async function call<Name extends ViewerActionName>(name: Name, args: object) {
        const reply = await adapter.invoke(name, args);
        expect('error' in reply ? reply.error : undefined, name).toBeUndefined();
        return viewerResult(name, 'result' in reply ? reply.result : undefined);
    }
    const initial = viewerResult('viewer_get_controls', await call('viewer_get_controls', {}));
    expect(initial.values).toEqual(expect.arrayContaining([expect.objectContaining({target: {control: 'app.views'}})]));
    for (const [target, value] of [
        [{control: 'view.background', viewId: 'right'}, {layerId: null, opacity: 50}],
        [{control: 'view.grid', viewId: 'right'}, {visible: true, mode: 'xyz', level: 10, autoLevel: false, color: 'aabbcc', opacity: 20}],
        [{control: 'app.preferences.hover'}, {enabled: false, fields: [{expression: 'id', customExpression: false, displayKey: 'Identity'}]}],
        [{control: 'app.preferences.navigation'}, {zoomStep: 0.2, featureZoomClearance: 12}],
        [{control: 'app.marker'}, {enabled: true, position: {lon: 11, lat: 48, alt: 0}}],
        [{control: 'view.projection', viewId: 'right'}, '2d']
    ] as const) {
        const reply = await call('viewer_set_control', {target, value});
        expect(reply).toMatchObject({status: 'applied', value});
    }
    await call('viewer_manage_view', {operation: 'remove', viewId: 'right'});
    await expect(page.locator('#mapViewContainer-1')).toHaveCount(0);
    const single = viewerResult('viewer_get_controls', await call('viewer_get_controls', {}));
    expect(availableValue(single.values.find(entry => entry.target.control === 'app.views')!)).toMatchObject({views: [{viewId: 'left'}]});
    await call('viewer_manage_view', {operation: 'create', viewId: 'left'});
    await expect(page.locator('#mapViewContainer-1 canvas').first()).toBeVisible();

    const source = 'version: 2\nname: MCP smoke\nrules:\n  - geometry: [line]\n    color: "#123456"\n';
    expect(await call('viewer_validate_style', {source})).toMatchObject({valid: true});
    expect(await call('viewer_validate_style', {source: 'rules: [\n'})).toMatchObject({valid: false});
    const created = viewerResult('viewer_edit_style', await call('viewer_edit_style', {operation: 'create', source, visible: false}));
    const styleId = created.styleId;
    expect(await call('viewer_get_style', {styleId})).toMatchObject({source, imported: true, visible: false});
    await call('viewer_edit_style', {operation: 'update', styleId, source: source.replace('#123456', '#654321')});
    expect(await call('viewer_get_style', {styleId})).toMatchObject({source: source.replace('#123456', '#654321')});
    await call('viewer_edit_style', {operation: 'visibility', styleId, visible: true});
    const catalog = viewerResult('viewer_list_styles', await call('viewer_list_styles', { styleId}));
    expect(catalog.items).toMatchObject([{id: styleId, visible: true}]);
    await call('viewer_edit_style', {operation: 'delete', styleId});
    expect(await call('viewer_list_styles', { styleId})).toMatchObject({complete: true, items: []});
    const diagnostics = viewerResult('viewer_get_diagnostics', await call('viewer_get_diagnostics', {viewId: 'left', sections: ['workers', 'gpu']}));
    expect(diagnostics.metrics.some(item => item.section === 'workers')).toBe(true);
    expect(diagnostics.unavailable.length).toBeGreaterThan(0);
    expect(adapter.connections).toHaveLength(1);
});
