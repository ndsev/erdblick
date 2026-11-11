import {waitForAppReady} from "../utils/ui-helpers";
import type { Page, WebSocketRoute } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ViewerActionClientMessage } from '../../../app/action/viewer-action-relay.contract';
import { expect, test } from '../fixtures/test';
import { cameraViewStateSchema, viewerActions } from "../utils/viewer-contract";

test.use({ stateSnapshot: null });

/** Browser-adapter fixture only: native MCP authentication/relay require separate backend integration tests. */
async function browserActions(page: Page, mismatch = false, manualRegistration = false) {
    const catalog = JSON.parse(readFileSync('static/browser/web-mcp-actions.json', 'utf8'));
    const clientId = randomUUID();
    const messages: ViewerActionClientMessage[] = [];
    const connections: WebSocketRoute[] = [];
    let protocol: number[] = [];
    let sequence = 0;
    // State controls must work in a real viewer with no selected map or loaded tiles.
    await page.route('**/sources?*', route => route.fulfill({ json: [] }));
    await page.route('**/mcp/info', route => route.fulfill({
        json: {
            enabled: true, endpoint: 'http://localhost:9000/mcp', authentication: 'local', scopes: [],
            catalogId: mismatch ? `sha256:${'a'.repeat(64)}` : catalog.catalogId
        }
    }));
    await page.route('**/interactive/payload?*', async route => {
        await new Promise(resolve => setTimeout(resolve, 100));
        await route.fulfill({ status: 204 });
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

    /** Delivers the transport identity independently from the registration acknowledgement. */
    function connect() {
        connections[0].send(frame(6, {type: 'mapget.tiles.request-context', requestId: 0, clientId}));
    }

    /** Sends a server control over the mocked wire, without calling application internals. */
    function sendControl(payload: object) {
        connections[0].send(frame(9, payload));
    }

    /** Completes registration when a status test releases the handshake. */
    function acknowledge() {
        sendControl({type: 'mapget.actions.registered', version: 1, clientId, catalogId: catalog.catalogId});
    }

    await page.routeWebSocket('**/interactive', socket => {
        connections.push(socket);
        socket.onMessage(raw => {
            const message = JSON.parse(raw.toString()) as ViewerActionClientMessage;
            if (!message.type?.startsWith('mapget.actions.')) return;
            messages.push(message);
            if (!manualRegistration && (message.type === 'mapget.actions.register' || message.type === 'mapget.actions.update')) {
                socket.send(frame(9, {
                    type: message.type === 'mapget.actions.register'
                        ? 'mapget.actions.registered' : 'mapget.actions.updated', version: 1, clientId, catalogId: catalog.catalogId
                }));
            }
        });
    });
    await page.goto('/?v2=1&n=2&vid=0,1&m=1&f=0&sync=&lon=10,20&lat=40,50&alt=500,1000&h=0,0&p=-1,-1&r=0,0&px=0,0&py=0,0&pz=0,0&m2d=0,0&bg=~10,~10&l=');
    await waitForAppReady(page);
    await expect.poll(() => page.evaluate(() => !!window.ebDebug)).toBe(true);
    protocol = await page.evaluate(() => {
        const core = window.ebDebug!.coreLib();
        return [core.tileLayerStreamProtocolMajor(), core.tileLayerStreamProtocolMinor(), 0];
    });
    await expect.poll(() => connections.length).toBe(1);
    if (!manualRegistration) connect();
    if (!mismatch && !manualRegistration) await expect.poll(() => messages.some(message => message.type === 'mapget.actions.register')).toBe(true);

    /** Sends one typed call over the socket and waits for its own result, never invoking a service through a debug hook. */
    async function invoke(action: string, args: object) {
        const callId = `browser-${++sequence}`;
        connections[0].send(frame(9, { type: 'mapget.actions.invoke', version: 1, callId, action, arguments: args, timeoutMs: 30000 }));
        await expect.poll(() => messages.some(message => message.type === 'mapget.actions.result' && message.callId === callId)).toBe(true);
        return messages.find(message => message.type === 'mapget.actions.result' && message.callId === callId) as Extract<ViewerActionClientMessage, { type: 'mapget.actions.result' }>;
    }
    return { invoke, messages, connections, connect, acknowledge, sendControl };
}

test('MCP availability shows waiting, connecting and ready tags with a labeled tab input', async ({page}) => {
    const adapter = await browserActions(page, false, true);
    await page.getByTestId('viewer-action-status').click();
    const details = page.getByTestId('viewer-action-details');
    const state = details.getByTestId('viewer-action-availability');
    await expect(details.getByTestId('viewer-action-connection')).toContainText('MCP tools');
    await expect(state).toHaveText('waiting');
    await expect(state).toHaveClass(/p-tag-warn/);
    await expect(details.getByTestId('viewer-action-connection-detail')).toContainText('interactive connection');

    const field = details.getByTestId('viewer-action-tab-label');
    const input = field.getByLabel('Tab label', {exact: true});
    const label = field.locator('label');
    // IftaLabel lets pointer events pass through its inset label to the input.
    await input.click();
    await expect(input).toBeFocused();
    const inputBox = (await input.boundingBox())!;
    const labelBox = (await label.boundingBox())!;
    expect(labelBox.y).toBeGreaterThan(inputBox.y);
    expect(labelBox.y + labelBox.height).toBeLessThan(inputBox.y + inputBox.height);
    expect(labelBox.x).toBeGreaterThanOrEqual(inputBox.x);
    expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(inputBox.x + inputBox.width);

    adapter.connect();
    await expect(state).toHaveText('connecting');
    await expect(state).toHaveClass(/p-tag-info/);
    await expect(details.getByTestId('viewer-action-connection-detail')).toHaveCount(0);
    adapter.acknowledge();
    await expect(state).toHaveText('ready');
    await expect(state).toHaveClass(/p-tag-success/);
    adapter.sendControl({type: 'mapget.actions.error', version: 1, operation: 'register',
        error: {code: 'not_available', message: 'Catalog retired', reason: 'catalog_changed'}});
    await expect(state).toHaveText('waiting');
    await expect(state).toHaveClass(/p-tag-warn/);
    await expect(details.getByTestId('viewer-action-connection-detail')).toContainText('reload the viewer');
    adapter.acknowledge();
    await expect(state).toHaveText('ready');
    await expect(details.getByTestId('viewer-action-connection-detail')).toHaveCount(0);
});

test('browser action adapter reads live views, moves only its target and updates activity without another click', async ({ page, context }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const first = await browserActions(page);
    const secondPage = await context.newPage();
    const second = await browserActions(secondPage);
    try {
        const targets = [{ control: 'view.camera', viewId: '0' }, { control: 'view.camera', viewId: '1' }];
        /** Checks the result boundary as well as successful transport. */
        async function read(adapter: typeof first) {
            const reply = await adapter.invoke('viewer_get_controls', { targets });
            expect('error' in reply ? reply.error : undefined).toBeUndefined();
            return viewerActions.viewer_get_controls.outputSchema.parse('result' in reply ? reply.result : undefined);
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
        await expect(details.getByTestId('viewer-action-availability')).toHaveText('ready');
        await expect(details.getByTestId('mcp-configure')).toBeVisible();
        await expect(details.getByTestId('mcp-setup')).toHaveCount(0);

        const value = { destination: { lon: 11.5374, lat: 48.1584, alt: 700 }, orientation: { heading: 0, pitch: -1, roll: 0 }, position: [0, 0, 0] };
        const reply = await first.invoke('viewer_set_control', { target: targets[1], value });
        expect('error' in reply ? reply.error : undefined).toBeUndefined();
        const applied = viewerActions.viewer_set_control.outputSchema.parse('result' in reply ? reply.result : undefined);
        expect(applied).toMatchObject({ status: 'applied', changed: true, readiness: { status: 'unknown' } });
        expect(cameraViewStateSchema.parse(applied.value).destination.lon).toBeCloseTo(value.destination.lon, 5);
        await expect(details.getByRole('listitem').filter({ hasText: 'viewer_set_control' })).toContainText('applied');
        const after = await read(first);
        expect(after.values[0]).toEqual(before.values[0]);
        expect((await read(second)).values).toEqual(otherBefore.values);
        expect(first.connections).toHaveLength(1);
        expect(second.connections).toHaveLength(1);

        await page.getByLabel('Tab label', { exact: true }).fill('Camera workbench');
        await page.getByLabel('Tab label', { exact: true }).press('Tab');
        await expect.poll(() => first.messages.some(message => message.type === 'mapget.actions.update' && message.label === 'Camera workbench')).toBe(true);
        const labelInput = page.getByLabel('Tab label', { exact: true });
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

test('MCP setup switches all platform and agent recipes and copies only the selected field', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { document.documentElement.dataset['copiedText'] = text; } }
    }));
    await browserActions(page);
    const status = page.getByTestId('viewer-action-status');
    await status.click();
    await page.getByTestId('mcp-configure').getByRole('button').click();
    const details = page.getByRole('dialog', { name: 'MCP Configuration', exact: true });
    const platforms = details.getByRole('group', { name: 'Platform', exact: true });
    const agents = details.getByRole('group', { name: 'Agent', exact: true });
    const labels = ['Codex CLI', 'ChatGPT App', 'Claude Code', 'Claude App',
        'Cursor CLI', 'Cursor IDE', 'Copilot CLI', 'VS Code', 'Vibe CLI'];
    await expect(agents).toHaveCount(0);
    for (const platform of ['Windows', 'macOS', 'Linux']) {
        await platforms.getByRole('button', { name: platform, exact: true }).click();
        await expect(agents.getByRole('button')).toHaveText(labels);
        for (const agent of labels) {
            await agents.getByRole('button', { name: agent, exact: true }).click();
            await expect(agents.getByRole('button', { pressed: true })).toHaveText(agent);
            if (agent.endsWith('App')) await details.getByRole('button', { name: 'Remote MCP', exact: true }).click();
            const fields = details.getByTestId(/^mcp-setup-field-/).getByRole('textbox');
            for (const field of await fields.all()) await expect(field).toHaveAttribute('readonly', '');
            const verify = details.getByTestId('mcp-setup-field-verify');
            if (await verify.count()) await expect(verify.locator('input')).toHaveCount(1);
            const config = details.getByLabel('JSON configuration', { exact: true });
            if (await config.count()) {
                const json = JSON.parse(await config.inputValue());
                const server = (json.servers ?? json.mcpServers).mapviewer;
                expect(server.url ?? server.args[2]).toBe('http://localhost:9000/mcp');
            }
            const selectedField = fields.last();
            const copied = await selectedField.inputValue();
            await details.getByTestId(/^mcp-setup-field-/).last().getByRole('button').click();
            await expect(page.locator('html')).toHaveAttribute('data-copied-text', copied);
            const link = details.getByTestId('mcp-provider-docs');
            await expect(link).toHaveAttribute('href', /^https:\/\//);
            await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        }
    }
    // A fresh opening starts the sequence again; choices are never persisted as map state.
    await details.getByRole('button', { name: 'Close', exact: true }).click();
    await status.click();
    await page.getByTestId('mcp-configure').getByRole('button').click();
    await expect(platforms.getByRole('button', { pressed: true })).toHaveCount(0);
    await expect(agents).toHaveCount(0);
    const windows = platforms.getByRole('button', { name: 'Windows', exact: true });
    await windows.focus();
    await windows.press('Space');
    await expect(windows).toHaveAttribute('aria-pressed', 'true');
    // This PrimeNG version exposes each toggle as a Tab stop; Space/Enter selects it.
    await windows.press('Tab');
    const mac = platforms.getByRole('button', { name: 'macOS', exact: true });
    await expect(mac).toBeFocused({ timeout: 5000 });
    await mac.press('Space');
    await expect(agents.getByRole('button', { pressed: true })).toHaveCount(0);
    await agents.getByRole('button', { name: 'VS Code', exact: true }).click();
    await expect(details.getByLabel('Configuration file', { exact: true })).toHaveValue('~/Library/Application Support/Code/User/mcp.json');
    const codex = agents.getByRole('button', { name: 'Codex CLI', exact: true });
    await codex.focus();
    await codex.press('Space');
    await expect(agents.getByRole('button', { pressed: true })).toHaveText('Codex CLI');
});

test('MCP setup falls back to a manual-copy dialog when clipboard access is denied', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); } }
    }));
    await browserActions(page);
    await page.getByTestId('viewer-action-status').click();
    await page.getByTestId('mcp-configure').getByRole('button').click();
    const setup = page.getByRole('dialog', { name: 'MCP Configuration', exact: true });
    await setup.getByRole('button', { name: 'Linux', exact: true }).click();
    await setup.getByRole('button', { name: 'Codex CLI', exact: true }).click();
    const field = setup.getByTestId('mcp-setup-field-add');
    const command = await field.getByRole('textbox').inputValue();
    await field.getByRole('button').click();
    const dialog = page.getByRole('dialog', { name: 'Clipboard Content', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox')).toHaveValue(command);
    await expect(dialog.getByRole('textbox')).toHaveAttribute('readonly', '');
    await dialog.getByRole('textbox').press('Escape');
    await expect(dialog).toBeHidden();
});

test('MCP configuration reveals stages, resizes naturally and copies the latest WebMCP route', async ({ page }) => {
    await page.setViewportSize({width: 1600, height: 1200});
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {writeText: async (text: string) => { document.documentElement.dataset['copiedText'] = text; }}
    }));
    const adapter = await browserActions(page);
    await page.getByTestId('viewer-action-status').click();
    await page.getByTestId('mcp-configure').getByRole('button').click();
    const dialog = page.getByRole('dialog', {name: 'MCP Configuration', exact: true});
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS('transform', /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    await expect(dialog.getByTestId('mcp-agent-selector')).toHaveCount(0);
    await expect(dialog.getByTestId('mcp-connection-selector')).toHaveCount(0);
    await expect(dialog.getByTestId('mcp-provider-docs')).toHaveCount(0);
    const platformHeight = (await dialog.boundingBox())!.height;
    await dialog.getByRole('button', {name: 'macOS', exact: true}).click();
    const agentHeight = (await dialog.boundingBox())!.height;
    expect(agentHeight).toBeGreaterThan(platformHeight);
    await dialog.getByRole('button', {name: 'ChatGPT App', exact: true}).click();
    const connectionHeight = (await dialog.boundingBox())!.height;
    expect(connectionHeight).toBeGreaterThan(agentHeight);
    await expect(dialog.getByTestId(/^mcp-setup-field-/)).toHaveCount(0);
    await dialog.getByRole('button', {name: 'WebMCP', exact: true}).click();
    expect((await dialog.boundingBox())!.height).toBeGreaterThan(connectionHeight);
    const url = dialog.getByLabel('Current viewer URL', {exact: true});
    await expect(url).toHaveValue(page.url());
    expect(new URL(await url.inputValue()).searchParams.get('vid')).toBe('0,1');
    await expect(dialog.getByRole('list', {name: 'Finish setup'})).toContainText('Cmd+T');
    await expect(dialog.getByTestId('mcp-provider-docs')).toHaveAttribute('href', 'https://learn.chatgpt.com/docs/webmcp');
    // Switching or reselecting a platform keeps the app and mode while refreshing its shortcut.
    const agents = dialog.getByRole('group', {name: 'Agent', exact: true});
    const connections = dialog.getByRole('group', {name: 'Connection', exact: true});
    await dialog.getByRole('button', {name: 'Windows', exact: true}).click();
    await expect(agents.getByRole('button', {pressed: true})).toHaveText('ChatGPT App');
    await expect(connections.getByRole('button', {pressed: true})).toHaveText('WebMCP');
    await expect(dialog.getByRole('list', {name: 'Finish setup'})).toContainText('Ctrl+T');
    await dialog.getByRole('button', {name: 'Windows', exact: true}).click();
    await expect(url).toHaveValue(page.url());
    await dialog.getByRole('button', {name: 'macOS', exact: true}).click();
    await expect(dialog.getByRole('list', {name: 'Finish setup'})).toContainText('Cmd+T');
    const oldUrl = page.url();
    const moved = await adapter.invoke('viewer_set_control', {
        target: {control: 'view.camera', viewId: '1'},
        value: {destination: {lon: 25, lat: 45, alt: 700}, orientation: {heading: 0, pitch: -1, roll: 0}, position: [0, 0, 0]}
    });
    expect('error' in moved ? moved.error : undefined).toBeUndefined();
    await expect.poll(() => page.url()).not.toBe(oldUrl);
    await expect(url).toHaveValue(page.url());
    await dialog.getByRole('button', {name: 'Copy Current viewer URL', exact: true}).click();
    await expect(page.locator('html')).toHaveAttribute('data-copied-text', page.url());
    await dialog.getByRole('button', {name: 'Remote MCP', exact: true}).click();
    await expect(url).toHaveCount(0);
    await expect(dialog.getByLabel('Server URL', {exact: true})).toHaveValue('http://localhost:9000/mcp');
    await dialog.getByRole('button', {name: 'Claude App', exact: true}).click();
    await expect(dialog.getByTestId(/^mcp-setup-field-/)).toHaveCount(0);
    await dialog.getByRole('button', {name: 'WebMCP', exact: true}).click();
    await expect(dialog.getByRole('list', {name: 'Finish setup'})).toContainText('Code session');
    await expect(dialog.getByRole('list', {name: 'Finish setup'})).toContainText('Cmd+Shift+B');
    await expect(dialog.getByTestId('mcp-provider-docs')).toHaveAttribute('href', 'https://code.claude.com/docs/en/desktop#browse-external-sites');
    await expect(dialog.getByRole('list', {name: 'Finish setup'})).toContainText('if unavailable, choose Remote MCP');
    await dialog.getByRole('button', {name: 'Remote MCP', exact: true}).click();
    await expect(dialog.getByLabel('Configuration file', {exact: true})).toHaveValue('~/Library/Application Support/Claude/claude_desktop_config.json');
    await dialog.getByRole('button', {name: 'Windows', exact: true}).click();
    await expect(agents.getByRole('button', {pressed: true})).toHaveText('Claude App');
    await expect(connections.getByRole('button', {pressed: true})).toHaveText('Remote MCP');
    await expect(dialog.getByLabel('Configuration file', {exact: true})).toHaveValue('%APPDATA%\\Claude\\claude_desktop_config.json');
    await dialog.getByRole('button', {name: 'Codex CLI', exact: true}).click();
    await expect(dialog.getByTestId('mcp-connection-selector')).toHaveCount(0);
    await expect(dialog.getByTestId('mcp-setup-field-add')).toBeVisible();
    await expect(dialog.getByLabel('Verify · PowerShell', {exact: true})).toHaveValue('codex mcp get mapviewer');
    await dialog.getByRole('button', {name: 'Linux', exact: true}).click();
    await expect(agents.getByRole('button', {pressed: true})).toHaveText('Codex CLI');
    await expect(dialog.getByLabel('Verify · Terminal', {exact: true})).toHaveValue('codex mcp get mapviewer');
    await dialog.getByRole('button', {name: 'Copy Verify · Terminal', exact: true}).click();
    await expect(page.locator('html')).toHaveAttribute('data-copied-text', 'codex mcp get mapviewer');
    await expect(dialog.getByTestId('mcp-connection-selector')).toHaveCount(0);
    expect((await dialog.boundingBox())!.height).toBeGreaterThan(agentHeight);
});

test('MCP activity turns green during pending work and gray after completion or stop without another click', async ({ page }) => {
    const adapter = await browserActions(page);
    const status = page.getByTestId('viewer-action-status').getByRole('button');
    await expect(status).toHaveClass(/p-button-secondary/);
    for (const finish of ['response', 'stop'] as const) {
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        await page.route('**/locate', async route => {
            await pending;
            await route.fulfill({ json: { responses: [[]] } });
        });
        const result = adapter.invoke('viewer_inspect', { features: [{ mapId: 'TestMap', featureId: 'Way.1' }] });
        try {
            // No click or open popover is needed to publish action activity.
            await expect(status).toHaveClass(/p-button-success/, { timeout: 10000 });
            if (finish === 'stop') {
                await status.click();
                await page.getByTestId('viewer-action-stop').getByRole('button').click();
            } else release();
            const reply = await result;
            expect('error' in reply ? reply.error.code : undefined).toBe(finish === 'stop' ? 'cancelled' : 'not_available');
            await expect(status).toHaveClass(/p-button-secondary/, { timeout: 10000 });
        } finally {
            release();
        }
    }
});

for (const darkMode of ['off', 'on'] as const) {
    test.describe(`MCP controls with dark mode ${darkMode}`, () => {
        test.use({ darkMode });
        test('spaces the status button, centers its arrow and fits the setup selectors and fields', async ({ page }, testInfo) => {
            await browserActions(page);
            const status = page.getByTestId('viewer-action-status').getByRole('button');
            await expect(status).toHaveClass(/p-button-secondary/);
            await expect(status).not.toHaveClass(/p-button-text/);
            await expect(status).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
            for (const width of [1600, 480, 360]) {
                const height = width === 360 ? 600 : 900;
                await page.setViewportSize({ width, height });
                const statusBox = await status.boundingBox();
                const diagnosticsBox = await page.locator('diagnostics-indicator').boundingBox();
                expect(diagnosticsBox!.x - statusBox!.x - statusBox!.width).toBeGreaterThanOrEqual(8);
                // Native diagnostics button font metrics differ across engines. Keep
                // the MCP button centered with at least the indicator's clearance.
                expect(statusBox!.height).toBeLessThanOrEqual(diagnosticsBox!.height + 2);
                expect(Math.abs(statusBox!.y + statusBox!.height / 2 - diagnosticsBox!.y - diagnosticsBox!.height / 2)).toBeLessThan(1);
                await status.click({ timeout: 10000 });
                const details = page.getByTestId('viewer-action-details');
                const overlay = page.getByRole('dialog').filter({ has: details });
                await expect(overlay).toBeVisible();
                await expect(overlay).toHaveCSS('transform', 'none', { timeout: 10000 });
                // PrimeNG draws a zero-width CSS triangle with balanced borders/margin.
                // Its computed left therefore identifies the visible arrow tip.
                await expect.poll(() => overlay.evaluate(element => {
                    const button = document.querySelector('[data-testid="viewer-action-status"] button')!;
                    const target = button.getBoundingClientRect();
                    const arrow = getComputedStyle(element, '::before');
                    const tip = element.getBoundingClientRect().left + parseFloat(arrow.left);
                    return Math.abs(tip - target.left - target.width / 2);
                }), { timeout: 10000 }).toBeLessThan(2);
                const overlayBox = await overlay.boundingBox();
                expect(overlayBox!.width).toBeLessThan(560);
                expect(overlayBox!.x).toBeGreaterThanOrEqual(0);
                expect(overlayBox!.x + overlayBox!.width).toBeLessThanOrEqual(width);
                expect(overlayBox!.y).toBeGreaterThanOrEqual(0);
                expect(overlayBox!.y + overlayBox!.height).toBeLessThanOrEqual(height);
                await details.getByTestId('mcp-configure').getByRole('button').click();
                await expect(details).toBeHidden();
                const setup = page.getByRole('dialog', { name: 'MCP Configuration', exact: true });
                const initialHeight = (await setup.boundingBox())!.height;
                const platforms = setup.getByRole('group', { name: 'Platform', exact: true });
                await platforms.getByRole('button', { name: 'Windows', exact: true }).click();
                const agents = setup.getByRole('group', { name: 'Agent', exact: true });
                const buttons = agents.getByRole('button');
                await expect(buttons).toHaveCount(9);
                await expect(buttons.last()).toBeVisible();
                const bounds = await buttons.evaluateAll(elements => elements.map(element => {
                    const { top, bottom, left, right } = element.getBoundingClientRect();
                    const label = element.querySelector('.p-togglebutton-label')!.getBoundingClientRect();
                    return { top, bottom, left, right, labelLeft: label.left, labelRight: label.right };
                }));
                for (const [index, box] of bounds.entries()) {
                    expect(box.right - box.left).toBeGreaterThan(0);
                    expect(box.left).toBeGreaterThanOrEqual(0);
                    expect(box.right).toBeLessThanOrEqual(width);
                    expect(box.labelLeft).toBeGreaterThanOrEqual(box.left);
                    expect(box.labelRight).toBeLessThanOrEqual(box.right);
                    // Nine equal options form three joined columns and three rows.
                    if (index % 3) expect(Math.abs(box.left - bounds[index - 1].right)).toBeLessThan(1);
                    if (index >= 3) expect(Math.abs(box.top - bounds[index - 3].bottom)).toBeLessThan(1);
                }
                expect((await setup.boundingBox())!.height).toBeGreaterThan(initialHeight);
                await agents.getByRole('button', { name: 'Claude App', exact: true }).click();
                await setup.getByRole('button', { name: 'Remote MCP', exact: true }).click();
                await expect(setup.getByLabel('Configuration file', { exact: true })).toHaveValue('%APPDATA%\\Claude\\claude_desktop_config.json');
                const config = setup.getByLabel('JSON configuration', { exact: true });
                await config.scrollIntoViewIfNeeded();
                const configBox = await config.boundingBox();
                expect(configBox!.x).toBeGreaterThanOrEqual(0);
                expect(configBox!.x + configBox!.width).toBeLessThanOrEqual(width);
                expect(await setup.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
                const provider = setup.getByTestId('mcp-provider-docs');
                await provider.scrollIntoViewIfNeeded();
                await expect(provider).toBeInViewport();
                await expect(setup.getByRole('button', { name: 'Copy JSON configuration', exact: true })).toBeEnabled();
                await page.mouse.move(0, 0);
                const screenshot = testInfo.outputPath(`mcp-controls-${darkMode}-${width}.png`);
                await page.screenshot({ path: screenshot });
                await testInfo.attach(`mcp-controls-${darkMode}-${width}`, { path: screenshot, contentType: 'image/png' });
                const setupBox = (await setup.boundingBox())!;
                expect(setupBox.y).toBeGreaterThanOrEqual(0);
                expect(setupBox.y + setupBox.height).toBeLessThanOrEqual(height);
                await setup.getByRole('button', { name: 'Close', exact: true }).click();
                await expect(setup).toBeHidden();
            }
        });
    });
}

test('catalog mismatch disables agent controls without hiding the map or opening another socket', async ({ page }) => {
    const adapter = await browserActions(page, true);
    await page.getByTestId('viewer-action-status').click();
    await expect(page.getByTestId('viewer-action-details')).toContainText('catalogs do not match');
    await expect(page.getByTestId('viewer-action-availability')).toHaveText('waiting');
    await expect(page.getByTestId('viewer-action-availability')).toHaveClass(/p-tag-warn/);
    await expect(page.getByTestId('viewer-action-status').getByRole('button')).toHaveClass(/p-button-danger/);
    await expect(page.locator('#mapViewContainer-0 canvas').first()).toBeVisible();
    expect(adapter.messages).toEqual([]);
    expect(adapter.connections).toHaveLength(1);
});

test('browser actions share settings, view lifecycle, style editing and diagnostics with their real owners', async ({ page }) => {
    const adapter = await browserActions(page);
    /** Exercises typed wire replies, not private service/debug methods. */
    async function call<Name extends keyof typeof viewerActions>(name: Name, args: object) {
        const reply = await adapter.invoke(name, args);
        expect('error' in reply ? reply.error : undefined, name).toBeUndefined();
        return viewerActions[name].outputSchema.parse('result' in reply ? reply.result : undefined);
    }
    const initial = viewerActions.viewer_get_controls.outputSchema.parse(await call('viewer_get_controls', {}));
    for (const [target, value] of [
        [{ control: 'view.background', viewId: '1' }, { layerId: null, opacity: 50 }],
        [{ control: 'view.grid', viewId: '1' }, { visible: true, mode: 'xyz', level: 10, autoLevel: false, color: 'aabbcc', opacity: 20 }],
        [{ control: 'app.preferences.hover' }, { enabled: false, fields: [{ expression: 'id', customExpression: false, displayKey: 'Identity' }] }],
        [{ control: 'app.preferences.navigation' }, { zoomStep: 0.2, featureZoomClearance: 12 }],
        [{ control: 'app.marker' }, { enabled: true, position: { lon: 11, lat: 48, alt: 0 } }],
        [{ control: 'view.projection', viewId: '1' }, '2d']
    ] as const) {
        const reply = await call('viewer_set_control', { target, value });
        expect(reply).toMatchObject({ status: 'applied', value });
    }
    await call('viewer_manage_view', { operation: 'remove', viewId: '1' });
    await expect(page.locator('#mapViewContainer-1')).toHaveCount(0);
    const single = viewerActions.viewer_get_controls.outputSchema.parse(await call('viewer_get_controls', {}));
    expect(single.values.find(entry => entry.target.control === 'app.views')).toMatchObject({ value: { views: [{ viewId: '0' }] } });
    await call('viewer_manage_view', { operation: 'create', viewId: '0' });
    await expect(page.locator('#mapViewContainer-1 canvas').first()).toBeVisible();

    const source = 'version: 2\nname: MCP smoke\nrules:\n  - geometry: [line]\n    color: "#123456"\n';
    expect(await call('viewer_validate_style', { source })).toMatchObject({ valid: true });
    expect(await call('viewer_validate_style', { source: 'rules: [\n' })).toMatchObject({ valid: false });
    const created = viewerActions.viewer_edit_style.outputSchema.parse(await call('viewer_edit_style', { operation: 'create', source, visible: false }));
    const styleId = created.styleId;
    expect(await call('viewer_get_style', { styleId })).toMatchObject({ source, imported: true, visible: false });
    await call('viewer_edit_style', { operation: 'update', styleId, source: source.replace('#123456', '#654321') });
    expect(await call('viewer_get_style', { styleId })).toMatchObject({ source: source.replace('#123456', '#654321') });
    await call('viewer_edit_style', { operation: 'visibility', styleId, visible: true });
    const catalog = viewerActions.viewer_list_styles.outputSchema.parse(await call('viewer_list_styles', { styleId }));
    expect(catalog.items).toMatchObject([{ id: styleId, visible: true }]);
    await call('viewer_edit_style', { operation: 'delete', styleId });
    expect(await call('viewer_list_styles', { styleId })).toMatchObject({ complete: true, items: [] });
    const diagnostics = viewerActions.viewer_get_diagnostics.outputSchema.parse(await call('viewer_get_diagnostics', { viewId: '0', sections: ['workers', 'gpu'] }));
    expect(diagnostics.metrics.some(item => item.section === 'workers')).toBe(true);
    expect(diagnostics.unavailable.length).toBeGreaterThan(0);
    expect(adapter.connections).toHaveLength(1);
});
