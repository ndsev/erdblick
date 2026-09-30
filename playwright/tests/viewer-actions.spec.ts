import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Page, WebSocketRoute} from '@playwright/test';
import {expect, test} from '../fixtures/test';
import type {ViewerActionClientMessage} from '../../app/actions/viewer-action-relay.contract';
import {viewerActions} from '../../app/actions/viewer-action.contract';

test.use({stateSnapshot: null});

/** Browser-adapter fixture only: native MCP authentication/relay require separate backend integration tests. */
async function browserActions(page: Page, mismatch = false) {
    const catalog = JSON.parse(readFileSync('static/browser/viewer-actions.json', 'utf8'));
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
    await page.goto('/?v2=1&n=2&m=1&f=0&sync=&lon=10,20&lat=40,50&alt=500,1000&h=0,0&p=-1,-1&r=0,0&px=0,0&py=0,0&pz=0,0&m2d=0,0&bg=~10,~10&l=');
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
        const targets = [{channel: 'view.camera', viewIndex: 0}, {channel: 'view.camera', viewIndex: 1}];
        /** Checks the result boundary as well as successful transport. */
        async function read(adapter: typeof first) {
            const reply = await adapter.invoke('viewer_get_app_state', {targets});
            expect('error' in reply ? reply.error : undefined).toBeUndefined();
            return viewerActions.viewer_get_app_state.outputSchema.parse('result' in reply ? reply.result : undefined);
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

        const value = {destination: {lon: 11.5374, lat: 48.1584, alt: 700}, orientation: {heading: 0, pitch: -1, roll: 0}, position: [0, 0, 0]};
        const reply = await first.invoke('viewer_set_app_state', {target: targets[1], value, viewLayoutRevision: before.viewLayoutRevision});
        expect('error' in reply ? reply.error : undefined).toBeUndefined();
        const applied = viewerActions.viewer_set_app_state.outputSchema.parse('result' in reply ? reply.result : undefined);
        expect(applied).toMatchObject({status: 'applied', focusedView: 1, affectedViews: [1], changed: true, readiness: {status: 'unknown'}});
        expect(applied.value.destination.lon).toBeCloseTo(value.destination.lon, 5);
        await expect(details.getByRole('listitem').filter({hasText: 'viewer_set_app_state'})).toContainText('applied');
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

test('catalog mismatch disables agent controls without hiding the map or opening another socket', async ({page}) => {
    const adapter = await browserActions(page, true);
    await page.getByTestId('viewer-action-status').click();
    await expect(page.getByTestId('viewer-action-details')).toContainText('catalogs do not match');
    await expect(page.locator('#mapViewContainer-0 canvas').first()).toBeVisible();
    expect(adapter.messages).toEqual([]);
    expect(adapter.connections).toHaveLength(1);
});
