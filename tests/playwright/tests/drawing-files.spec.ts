import {expect, test} from '../fixtures/test';
import {navigateToStateSnapshotRoot, openMainMenu, openLocationPreferences, waitForAppReady} from '../utils/ui-helpers';
import type {Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';

test.use({stateSnapshot: 'location_navigation', stateSnapshotOnce: true, actionTimeout: 20000});

/** Open either local file choice through the public File menu. */
async function fileMenu(page: Page, name: string): Promise<void> {
    const menu = await openMainMenu(page, 'File');
    await menu.getByRole('menuitem', {name: new RegExp(name + '$')}).click();
}

/** Reveal a restored file through its public map-tree menu. */
async function localMapAction(page: Page, name: string, action: string): Promise<void> {
    if (!(await page.getByTestId('map-tree-0').isVisible())) await page.getByTestId('maps-toggle').click();
    if (action === 'Remove local map') page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', {name: (action === 'Open in Editor' ? 'Edit ' : 'Delete ') + name, exact: true}).click();
    if (await page.getByTestId('map-tree-0').isVisible()) await page.getByTestId('maps-toggle').click();
}

/** Local tests need no datasource; retain the real bundled drawing style and native core. */
async function localOnly(page: Page): Promise<string[]> {
    const requests: string[] = [];
    page.on('request', request => {
        if (/drawing-[0-9a-f]{8}-/.test(request.url() + (request.postData() ?? ''))) requests.push(request.url());
    });
    page.on('websocket', socket => socket.on('framesent', event => {
        if (typeof event.payload === 'string' && event.payload.includes('drawing-')) requests.push('websocket:' + event.payload);
    }));
    await page.route(/\/sources(?:\?.*)?$/, route => route.fulfill({json: []}));
    await navigateToStateSnapshotRoot(page);
    return requests;
}

test('imports coordinates, renders native subsets, edits and restores source without local network traffic', async ({page}) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const requests = await localOnly(page);
    await fileMenu(page, 'New coordinates');
    await page.getByLabel('Choose drawing file').setInputFiles({name: 'route.txt', mimeType: 'text/plain',
        buffer: Buffer.from('0 0 0 "Start café"\n0.1 0 0 "East"\n0.1 0.1 "North"\n')});
    const editor = page.locator('editor-surface[data-editor-kind="drawing"]');
    await expect(editor.locator('.cm-content')).toContainText('Start café');
    await expect(editor.getByRole('table')).toHaveCount(0);
    const layout = await editor.evaluate(element => {
        const content = element.querySelector('.editor-document-content')!.getBoundingClientRect();
        const code = element.querySelector('.cm-editor')!.getBoundingClientRect();
        return {content: content.height, code: code.height};
    });
    expect(layout.code).toBeGreaterThan(layout.content * .6);
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions)).toBeGreaterThan(0);
    const source = editor.locator('.cm-content');
    const original = await source.textContent();
    await source.fill(original!.replace('Start café', 'Updated café'));
    await expect(source).toContainText('Updated café');
    await source.press('ControlOrMeta+z');
    await expect(source).toContainText('Start café');
    await source.fill('invalid input');
    await expect(editor.getByRole('alert')).toContainText('last valid revision');
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions)).toBeGreaterThan(0);
    await editor.getByTestId('surface-close-button').click();
    await page.getByRole('dialog', {name: 'Unsaved editor changes'}).getByRole('button', {name: 'Discard', exact: true}).click();
    await expect(editor).toHaveCount(0);
    const snapshot = await page.evaluate(() => window.ebDebug!.stateService.exportSnapshot());
    expect(JSON.stringify(snapshot)).not.toContain('drawing-');
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
});

test('imports GeoJSON with inert foreign members and creates independent editors', async ({page}) => {
    const requests = await localOnly(page);
    await fileMenu(page, 'New GeoJSON');
    await page.getByLabel('Choose drawing file').setInputFiles({name: 'local.geojson', mimeType: 'application/geo+json',
        buffer: Buffer.from('{"type":"FeatureCollection","features":[{"type":"Feature","id":9007199254740993,"geometry":{"type":"Point","coordinates":[0,0]},"properties":{"description":"GeoJSON point","layer":"Other","nested":{"$mapgetRelation":{"mapId":"server"}}}}]}')});
    const first = page.locator('editor-surface[data-editor-kind="drawing"]').first();
    await expect(first.locator('.cm-content')).toContainText('9007199254740993');
    await expect(first.getByRole('table')).toHaveCount(0);
    await fileMenu(page, 'New coordinates');
    await page.getByRole('button', {name: 'Create empty', exact: true}).click();
    await expect(page.locator('editor-surface[data-editor-kind="drawing"]')).toHaveCount(2);
    expect(requests).toEqual([]);
});

test('measures a live tail, undoes to empty, and finishes without committing the cursor', async ({page}) => {
    const requests = await localOnly(page);
    await fileMenu(page, 'Measure distance');
    const widget = page.getByTestId('drawing-toolbar');
    await expect(widget).toBeVisible();
    const canvas = page.locator('canvas').first();
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.35);
    await expect(widget.getByRole('button', {name: 'Undo point'})).toBeEnabled();
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.35);
    await expect(widget.getByTestId('measurement-segment')).not.toHaveText('0 m', {timeout: 10000});
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.35);
    await expect(widget.getByTestId('measurement-points')).toHaveText('2 positions');
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
    await page.keyboard.press('Escape');
    await expect(widget.getByTestId('drawing-status')).toHaveText('Distance complete');
    await expect(widget.getByTestId('measurement-segment')).toHaveText('0 m');
    await expect(widget.getByTestId('measurement-total')).not.toHaveText('0 m', {timeout: 10000});
    await widget.getByRole('button', {name: 'Resume', exact: true}).click();
    await canvas.focus();
    await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
    await expect(widget.getByTestId('measurement-total')).toHaveText('0 m');
    await widget.getByTestId('drawing-options-toggle').click();
    await page.getByTestId('drawing-options').getByLabel('Unit').selectOption('miles');
    await page.getByTestId('drawing-options').getByLabel('Unit').press('Escape');
    await expect(page.getByTestId('drawing-options')).toBeHidden();
    await expect(widget.getByRole('button', {name: 'Finish', exact: true})).toBeVisible();
    await expect(widget.getByTestId('measurement-total')).toHaveText('0 mi');
    expect(requests).toEqual([]);
});

test('picks and inspects local coordinates with ordinary hover labels disabled', async ({page}) => {
    const requests = await localOnly(page);
    const preferences = await openLocationPreferences(page);
    await preferences.getByRole('tab', {name: 'Hover Labels', exact: true}).click();
    await preferences.getByLabel('Show hover labels', {exact: true}).uncheck();
    await preferences.getByRole('button', {name: /Close$/}).last().click();
    await fileMenu(page, 'New coordinates');
    await page.getByLabel('Choose drawing file').setInputFiles({name: 'hover.txt', mimeType: 'text/plain',
        buffer: Buffer.from('0 0 "Local hover café"\n')});
    const editor = page.locator('editor-surface[data-editor-kind="drawing"]');
    await expect(editor.locator('.cm-content')).toContainText('FeatureCollection');
    await editor.getByRole('button', {name: 'Center', exact: true}).click();
    await editor.getByTestId('surface-close-button').click();
    await page.getByRole('dialog', {name: 'Unsaved editor changes'}).getByRole('button', {name: 'Discard', exact: true}).click();
    await expect(editor).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions)).toBeGreaterThan(0);
    const box = (await page.locator('canvas').first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByRole('tooltip')).toContainText('Local hover café');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByTestId('inspection-panel').first()).toContainText('DrawingFeature');
    expect(JSON.stringify(await page.evaluate(() => window.ebDebug!.stateService.exportSnapshot()))).not.toMatch(/drawing-[0-9a-f]{8}-/);
    expect(page.url()).not.toContain('drawing-');
    expect(requests).toEqual([]);
});

test('saves converted GeoJSON locally and downloads only through Export', async ({page}) => {
    const requests = await localOnly(page);
    const text = '0\t0\t12.5\t"Dropped café"\r\n';
    const transfer = await page.evaluateHandle(text => {
        const data = new DataTransfer(); data.items.add(new File([text], 'dropped.txt', {type: 'text/plain'})); return data;
    }, text);
    await page.locator('body').dispatchEvent('drop', {dataTransfer: transfer});
    const editor = page.locator('editor-surface[data-editor-kind="drawing"]');
    await expect(editor.locator('.cm-content')).toContainText('FeatureCollection');
    const downloads: string[] = [];
    page.on('download', download => downloads.push(download.suggestedFilename()));
    await editor.getByTestId('drawing-save').click();
    await expect(editor.getByTestId('drawing-save').getByRole('button')).toBeDisabled();
    expect(downloads).toEqual([]);
    const downloadPromise = page.waitForEvent('download');
    await editor.getByTestId('drawing-export').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('dropped.geojson');
    const saved = JSON.parse(await readFile((await download.path())!, 'utf8'));
    expect(saved.type).toBe('FeatureCollection');
    expect(saved.features[0].geometry.coordinates).toEqual([0, 0, 0.125]);
    expect(saved.features[0].properties.description).toBe('Dropped café');
    if (await editor.getByTestId('drawing-save').getByRole('button').isEnabled()) await editor.getByTestId('drawing-save').click();
    await editor.getByTestId('surface-close-button').click();
    await expect(editor).toHaveCount(0);
    expect(requests).toEqual([]);
});

test('restores GeoJSON and invalid drafts after reload, then persistently removes a local map', async ({page}) => {
    const requests = await localOnly(page);
    const original = '\ufeff0\t0\t25\t"Persistent café"\r\n';
    await fileMenu(page, 'New coordinates');
    await page.getByLabel('Choose drawing file').setInputFiles({name: 'persistent.txt', mimeType: 'text/plain', buffer: Buffer.from(original)});
    let editor = page.locator('editor-surface[data-editor-kind="drawing"]');
    const source = editor.locator('.cm-content');
    await expect(source).toContainText('Persistent café');
    await source.fill((await source.textContent())!.replace('Persistent café', 'Accepted edit'));
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('drawingDocumentData:'))
        .some(key => JSON.parse(localStorage.getItem(key)!).source.includes('Accepted edit')))).toBe(true);
    await editor.locator('.cm-content').fill('unfinished coordinate draft');
    await expect(editor.getByRole('alert')).toContainText('last valid revision');
    await expect(editor.getByTestId('drawing-persistence')).toContainText('Draft kept in this browser');
    await fileMenu(page, 'New GeoJSON');
    const geojson = '{"type":"Feature","id":9007199254740993,"geometry":{"type":"Point","coordinates":[0.1,0]},"properties":{"name":"Persistent GeoJSON"}}\r\n';
    await page.getByLabel('Choose drawing file').setInputFiles({name: 'feature.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(geojson)});
    await expect(editor).toHaveCount(2);
    await expect(editor.last().getByTestId('drawing-persistence')).toContainText('Draft kept in this browser');
    await fileMenu(page, 'Measure distance');
    await expect(page.getByTestId('measurement-widget')).toBeVisible();
    await page.reload(); await waitForAppReady(page);
    await expect(editor).toHaveCount(0);
    await expect(page.getByTestId('measurement-widget')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions)).toBeGreaterThanOrEqual(2);
    await localMapAction(page, 'persistent.geojson', 'Open in Editor');
    editor = page.locator('editor-surface[data-editor-kind="drawing"]');
    await expect(editor.locator('.cm-content')).toHaveText('unfinished coordinate draft');

    await expect(editor.getByRole('alert')).toContainText('last valid revision');
    await editor.getByTestId('surface-close-button').click();
    await page.getByRole('dialog', {name: 'Unsaved editor changes'}).getByRole('button', {name: 'Discard', exact: true}).click();
    await expect(editor).toHaveCount(0);
    await localMapAction(page, 'persistent.geojson', 'Open in Editor');
    const coordinateDownload = page.waitForEvent('download');
    await editor.getByTestId('drawing-export').click();
    const coordinates = JSON.parse(await readFile((await (await coordinateDownload).path())!, 'utf8'));
    expect(coordinates.features[0].geometry.coordinates).toEqual([0, 0, 0.25]);
    expect(coordinates.features[0].properties.description).toBe('Persistent café');
    if (await editor.getByTestId('drawing-save').getByRole('button').isEnabled()) await editor.getByTestId('drawing-save').click();
    await editor.getByTestId('surface-close-button').click();
    await localMapAction(page, 'feature.geojson', 'Open in Editor');
    await expect(editor.locator('.cm-content')).toContainText('9007199254740993');
    const geojsonDownload = page.waitForEvent('download');
    await editor.getByTestId('drawing-export').click();
    expect(await readFile((await (await geojsonDownload).path())!, 'utf8')).toBe(geojson);
    if (await editor.getByTestId('drawing-save').getByRole('button').isEnabled()) await editor.getByTestId('drawing-save').click();
    await editor.getByTestId('surface-close-button').click();
    await localMapAction(page, 'persistent.geojson', 'Remove local map');
    await page.reload(); await waitForAppReady(page);
    await page.getByTestId('maps-toggle').click();
    await expect(page.getByRole('button', {name: 'Map actions for feature.geojson', exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Map actions for persistent.geojson', exact: true})).toHaveCount(0);
    expect(JSON.stringify(await page.evaluate(() => window.ebDebug!.stateService.exportSnapshot()))).not.toMatch(/drawing-[0-9a-f]{8}-/);
    expect(requests).toEqual([]);
});

test('reports unavailable browser storage and restores a drawing after a successful retry', async ({page}) => {
    await localOnly(page);
    const restoreStorage = await page.evaluateHandle(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key: string, value: string) {
            if (key.startsWith('drawingDocumentData:')) throw new DOMException('Storage full', 'QuotaExceededError');
            original.call(this, key, value);
        };
        return () => { Storage.prototype.setItem = original; };
    });
    await fileMenu(page, 'New coordinates');
    await page.getByLabel('Choose drawing file').setInputFiles({name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('0 0 "Recoverable"\n')});
    const editor = page.locator('editor-surface[data-editor-kind="drawing"]');
    await expect(editor.locator('.cm-content')).toContainText('FeatureCollection');
    const status = page.getByTestId('drawing-storage-status');
    await expect(status).toContainText('Browser copy not updated');
    await expect(editor.getByTestId('drawing-persistence')).toContainText('not updated');
    await restoreStorage.evaluate(restore => restore());
    await status.getByRole('button', {name: 'Retry browser save'}).click();
    await expect(status).toBeHidden();
    await expect(editor.getByTestId('drawing-persistence')).toContainText('Draft kept in this browser');
    await page.reload(); await waitForAppReady(page);
    await localMapAction(page, 'retry.geojson', 'Open in Editor');
    await expect(editor.locator('.cm-content')).toContainText('Recoverable');
});

test('keeps a live measurement responsive during a 100,000-row native import', async ({page, browserName}, testInfo) => {
    test.skip(browserName !== 'chromium', 'Capacity qualification uses the Chromium software-rendering project.');
    test.setTimeout(180000);
    const requests = await localOnly(page);
    await fileMenu(page, 'Measure distance');
    const widget = page.getByTestId('drawing-toolbar');
    const box = (await page.locator('canvas').first().boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.7);
    await expect(widget.getByTestId('measurement-points')).toHaveText('1 positions');
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.7);
    await expect(widget.getByTestId('measurement-segment')).not.toHaveText('0 m');
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions)).toBeGreaterThanOrEqual(2);
    const previous = await widget.getByTestId('measurement-segment').textContent();
    const uploads = await page.evaluate(() => window.ebDebug!.subsetRenderPresentation().uploadCount);
    const text = Array.from({length: 100000}, (_, index) => `${index / 1000} 0 "Record ${index}"\n`).join('');
    const transfer = await page.evaluateHandle(text => {
        const data = new DataTransfer(); data.items.add(new File([text], 'capacity.txt', {type: 'text/plain'})); return data;
    }, text);
    const start = Date.now();
    await page.locator('body').dispatchEvent('drop', {dataTransfer: transfer});
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.7);
    await expect(widget.getByTestId('measurement-segment')).not.toHaveText(previous!, {timeout: 3000});
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().uploadCount), {timeout: 3000}).toBeGreaterThan(uploads);
    const previewMs = Date.now() - start;
    await expect(page.locator('editor-surface[data-editor-kind="drawing"]')).toHaveCount(0);
    const editor = page.locator('editor-surface[data-editor-kind="drawing"]');
    await expect(editor.locator('.cm-content')).toContainText('Record 0', {timeout: 120000});
    // CodeMirror virtualizes this long JSON line. Move left from the final newline to reveal its end.
    await editor.locator('.cm-content').press('ControlOrMeta+End');
    await editor.locator('.cm-content').press('ArrowLeft');
    await expect(editor.locator('.cm-content')).toContainText('Record 99999', {timeout: 10000});
    await expect(editor.locator('.cm-content')).toContainText('FeatureCollection', {timeout: 10000});
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions), {timeout: 30000}).toBeGreaterThan(2);
    const timing = {rows: 100000, previewMs, importAndRenderMs: Date.now() - start};
    console.info('Drawing capacity qualification:', JSON.stringify(timing));
    await testInfo.attach('drawing-capacity-timing.json', {body: JSON.stringify(timing), contentType: 'application/json'});
    expect(requests).toEqual([]);
});


test('groups local and remote maps, hides the Drawing node and retains an editable measurement after closing', async ({page}, testInfo) => {
    const requests = await localOnly(page);
    // Include one ready remote entry to verify presentation grouping without introducing data requests.
    await page.route(/\/sources(?:\?.*)?$/, route => route.fulfill({json: [{mapId: 'Remote fixture', sourceId: 'remote-fixture',
        stringPoolId: 'remote-fixture', layers: {}, maxParallelJobs: 0, addOn: false, extraJsonAttachment: {},
        protocolVersion: {major: 1, minor: 0, patch: 0}}]}));
    await page.reload(); await waitForAppReady(page);
    await fileMenu(page, 'Measure distance');
    const widget = page.getByTestId('drawing-toolbar'), canvas = page.locator('canvas').first();
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.35);
    await expect(widget.getByTestId('measurement-points')).toHaveText('1 positions');
    // Wait for the live tail before the next click, including first-use shader setup in WebKit.
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.35);
    await expect(widget.getByTestId('measurement-segment')).not.toHaveText('0 m');
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions)).toBeGreaterThanOrEqual(2);
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.35);
    await expect(widget.getByTestId('measurement-points')).toHaveText('2 positions');
    await widget.getByTestId('drawing-toolbar-close').click();
    await expect(widget).toBeHidden();
    await page.getByTestId('maps-toggle').click();
    const tree = page.getByTestId('map-tree-0');
    await expect(tree.getByTestId('origin:local')).toBeVisible();
    await expect(tree.getByTestId('origin:remote')).toBeVisible();
    await expect(tree.locator('p-tag').filter({hasText: 'local'})).toHaveCount(1);
    await expect(tree.getByText('Drawing', {exact: true})).toHaveCount(0);
    await page.screenshot({path: testInfo.outputPath('local-datasources.png')});
    await tree.getByTestId('origin:local').getByRole('checkbox').uncheck();
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions)).toBe(0);
    await tree.getByTestId('origin:local').getByRole('checkbox').check();
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions)).toBeGreaterThan(0);
    await page.getByTestId('source-grouping-0').press('Enter');
    await expect(page.getByTestId('source-grouping-0')).toHaveAttribute('aria-pressed', 'false');
    await expect(tree.getByTestId('origin:local')).toHaveCount(0);
    await expect(tree.getByRole('button', {name: 'Edit Measurement.geojson', exact: true})).toBeVisible();
    await page.reload(); await waitForAppReady(page);
    if (!(await tree.isVisible())) await page.getByTestId('maps-toggle').click();
    await expect(tree.getByTestId('origin:local')).toHaveCount(0); // Preference survives reload.
    await page.getByTestId('source-grouping-0').click();
    await expect(tree.getByTestId('origin:local')).toBeVisible();
    await tree.getByRole('button', {name: 'Edit Measurement.geojson', exact: true}).click();
    const editor = page.locator('editor-surface[data-editor-kind="drawing"]');
    await expect(editor.getByRole('table')).toHaveCount(0);
    await expect(editor.locator('.cm-content')).toContainText('measurement-path');
    const stored = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('drawingDocumentData:'))
        .map(key => JSON.parse(localStorage.getItem(key)!)));
    expect(stored).toHaveLength(1); expect(stored[0].schemaVersion).toBe(2); expect(stored[0].kind).toBeUndefined();
    expect(JSON.parse(stored[0].source).type).toBe('FeatureCollection');
    const downloadPromise = page.waitForEvent('download');
    await editor.getByTestId('drawing-export').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('Measurement.geojson');
    expect(JSON.parse(await readFile((await download.path())!, 'utf8')).features).toHaveLength(5);
    if (await editor.getByTestId('drawing-save').getByRole('button').isEnabled()) await editor.getByTestId('drawing-save').click();
    await editor.getByTestId('surface-close-button').click();
    await expect(editor).toHaveCount(0);
    page.once('dialog', dialog => dialog.accept());
    await tree.getByRole('button', {name: 'Delete Measurement.geojson', exact: true}).click();
    await expect(editor).toHaveCount(0);
    await expect(tree.getByRole('button', {name: 'Edit Measurement.geojson', exact: true})).toHaveCount(0);
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('drawingDocumentData:')))).toBe(false);
    expect(requests).toEqual([]);
});


test('moves the compact toolbar, snaps measurements, and creates colored area, angle, pen, point, polygon and ellipse results', async ({page}, testInfo) => {
    const renderErrors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') renderErrors.push(message.text()); });
    page.on('pageerror', error => renderErrors.push(error.message));
    const requests = await localOnly(page);
    await fileMenu(page, 'Drawing tools');
    const toolbar = page.getByTestId('drawing-toolbar');
    await expect(toolbar).toBeVisible();
    await expect(page.getByRole('dialog').filter({has: toolbar})).toHaveCount(0);
    const before = (await toolbar.boundingBox())!;
    expect(before.height).toBeLessThan(80);
    // Put the toolbar at the right edge, leaving all drawing gestures unobstructed.
    const handle = (await toolbar.getByTestId('drawing-toolbar-grip').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down(); await page.mouse.move(handle.x + handle.width / 2 + 480, handle.y + handle.height / 2 - 100, {steps: 12}); await page.mouse.up();
    await expect.poll(async () => (await toolbar.boundingBox())!.x).toBeGreaterThan(before.x + 100);
    const colorPicker = toolbar.getByRole('textbox', {name: 'Drawing color', exact: true});
    const initialColor = await colorPicker.evaluate(element => getComputedStyle(element).backgroundColor);
    await colorPicker.press('Space');
    await expect(page.locator('.p-colorpicker-panel')).toBeInViewport({ratio: 1});
    await page.locator('.p-colorpicker-color-selector').click({position: {x: 75, y: 75}});
    await expect(colorPicker).not.toHaveCSS('background-color', initialColor);
    const pickedColor = await colorPicker.evaluate(element => {
        const rgb = getComputedStyle(element).backgroundColor.match(/\d+/g)!;
        return '#' + rgb.slice(0, 3).map(value => Number(value).toString(16).padStart(2, '0')).join('');
    });
    await page.keyboard.press('Escape');
    await expect(page.locator('.p-colorpicker-panel')).toBeHidden();
    await expect(toolbar.getByRole('button', {name: 'Finish', exact: true})).toBeVisible();
    const box = (await page.locator('canvas').first().boundingBox())!;
    const a = {x: box.x + box.width * .15, y: box.y + box.height * .4};
    const b = {x: box.x + box.width * .3, y: box.y + box.height * .4};
    const c = {x: box.x + box.width * .3, y: box.y + box.height * .25};
    const click = async (point: {x: number; y: number}, count: number) => {
        await page.mouse.move(point.x, point.y);
        await page.mouse.click(point.x, point.y);
        await expect(toolbar.getByTestId('measurement-points')).toHaveText(`${count} positions`);
        await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions)).toBeGreaterThan(0);
    };
    await click(a, 1);
    await page.mouse.move(b.x, b.y - 25);
    await expect(toolbar.getByTestId('measurement-segment')).not.toHaveText('0 m');
    await page.keyboard.down('Shift');
    await expect(toolbar.locator('.snap-indicator')).toHaveClass(/enabled/);
    await click({x: b.x, y: b.y - 25}, 2);
    await page.keyboard.up('Shift');
    await expect(toolbar.locator('.snap-indicator')).not.toHaveClass(/enabled/);
    await toolbar.getByRole('button', {name: 'Finish', exact: true}).click();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('drawingDocumentData:'))
        .some(key => JSON.parse(localStorage.getItem(key)!).source.includes('measurement-label')))).toBe(true);
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().labels)).toBe(2);
    await expect.poll(() => page.evaluate(() => {
        const queue = window.ebDebug!.subsetRenderQueue();
        return queue.queued + queue.inFlight + queue.ready;
    })).toBe(0);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => window.ebDebug!.subsetRenderPresentation().fatalPresentationFailures)).toBe(0);
    // Real Deck label rendering is visible in this artifact, not an HTML measurement overlay.
    await page.mouse.move(0, 0);
    await page.screenshot({path: testInfo.outputPath('drawing-toolbar-distance-labels.png')});
    await toolbar.getByTestId('drawing-tool-area').click();
    await click(a, 1); await click(b, 2); await page.mouse.move(c.x, c.y);
    await expect(toolbar.getByTestId('measurement-area')).not.toHaveText('0 m²');
    await click(c, 3); await toolbar.getByRole('button', {name: 'Finish', exact: true}).click();
    await toolbar.getByTestId('drawing-tool-angle').click();
    await click(a, 1); await click(b, 2); await click(c, 3);
    await expect(toolbar.getByTestId('measurement-angle')).toContainText('90.');
    for (const mode of ['polygon', 'ellipse', 'point']) {
        await toolbar.getByTestId('drawing-tool-' + mode).click();
        await click(a, 1);
        if (mode !== 'point') await click(c, 2);
        if (mode === 'polygon') await click(b, 3);
    }
    await toolbar.getByTestId('drawing-tool-pen').click();
    const cameraBeforePen = await page.evaluate(() => window.ebDebug!.getCamera(0));
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x, b.y, {steps: 20}); await page.mouse.move(c.x, c.y, {steps: 20}); await page.mouse.up();
    await expect(toolbar.getByTestId('drawing-status')).toHaveText('Pen complete');
    expect(await page.evaluate(() => window.ebDebug!.getCamera(0))).toBe(cameraBeforePen);
    await toolbar.getByTestId('drawing-toolbar-close').click();
    await expect(toolbar).toBeHidden();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('drawingDocumentData:')).length)).toBe(7);
    const results = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('drawingDocumentData:')).map(key => JSON.parse(localStorage.getItem(key)!)));
    for (const record of results) {
        const collection = JSON.parse(record.source);
        expect(collection.type).toBe('FeatureCollection');
        expect(collection.features.length).toBeGreaterThan(0);
        expect(collection.features.every((feature: {properties: {color: string}}) => feature.properties.color === pickedColor)).toBe(true);
    }
    for (const name of ['Area.geojson', 'Polygon.geojson', 'Ellipse.geojson'])
        expect(JSON.parse(results.find(record => record.name === name).source).features.some((f: {geometry: {type: string}}) => f.geometry.type === 'Polygon')).toBe(true);
    expect(JSON.parse(results.find(record => record.name === 'Pen.geojson').source).features[0].geometry.type).toBe('LineString');
    expect(renderErrors).toEqual([]);
    await page.reload(); await waitForAppReady(page);
    await expect.poll(() => page.evaluate(() => window.ebDebug!.subsetRenderPresentation().activeContributions)).toBeGreaterThanOrEqual(7);
    expect(requests).toEqual([]);
});


test('keeps the compact toolbar reachable after dragging, reload and a narrow viewport', async ({page}, testInfo) => {
    await localOnly(page);
    await fileMenu(page, 'Drawing tools');
    const toolbar = page.getByTestId('drawing-toolbar'), grip = toolbar.getByTestId('drawing-toolbar-grip');
    const before = (await toolbar.boundingBox())!;
    expect(before.height).toBeLessThan(80);
    const camera = await page.evaluate(() => window.ebDebug!.getCamera(0));
    await grip.focus();
    await grip.press('ArrowLeft');
    await expect.poll(async () => Math.round((await toolbar.boundingBox())!.x)).toBe(Math.round(before.x - 10));
    const handle = (await grip.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down(); await page.mouse.move(1595, 120, {steps: 8}); await page.mouse.up();
    const moved = (await toolbar.boundingBox())!;
    expect(moved.x).toBeGreaterThan(before.x + 100);
    expect(moved.x + moved.width).toBeLessThanOrEqual(1592);
    await expect(toolbar.getByTestId('measurement-points')).toHaveText('0 positions');
    expect(await page.evaluate(() => window.ebDebug!.getCamera(0))).toBe(camera);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('drawingToolbarPosition'))).not.toBeNull();
    expect(JSON.stringify(await page.evaluate(() => window.ebDebug!.stateService.exportSnapshot()))).not.toContain('drawingToolbarPosition');
    await page.reload(); await waitForAppReady(page);
    await expect(toolbar).toBeHidden();
    await fileMenu(page, 'Drawing tools');
    await expect.poll(async () => Math.round((await toolbar.boundingBox())!.x)).toBe(Math.round(moved.x));
    await expect.poll(async () => Math.round((await toolbar.boundingBox())!.y)).toBe(Math.round(moved.y));
    await page.setViewportSize({width: 360, height: 640});
    await expect.poll(async () => {
        const box = (await toolbar.boundingBox())!;
        return box.x >= 8 && box.y >= 8 && box.x + box.width <= 352 && box.y + box.height <= 632;
    }).toBe(true);
    expect((await toolbar.boundingBox())!.height).toBeLessThan(160);
    // Exercise the bottom corner too, where the map compass, attribution and coordinates live.
    const narrowGrip = (await grip.boundingBox())!;
    await page.mouse.move(narrowGrip.x + narrowGrip.width / 2, narrowGrip.y + narrowGrip.height / 2);
    await page.mouse.down(); await page.mouse.move(355, 635, {steps: 8}); await page.mouse.up();
    const controls = toolbar.locator('button, input, [data-testid="measurement-widget"]');
    expect(await controls.evaluateAll(elements => elements.every(element => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }))).toBe(true);
    await toolbar.getByTestId('drawing-tool-area').click();
    await expect(toolbar.getByTestId('measurement-area')).toBeVisible();
    const colorPicker = toolbar.getByRole('textbox', {name: 'Drawing color', exact: true});
    await colorPicker.click();
    await expect(page.locator('.p-colorpicker-panel')).toBeInViewport({ratio: 1});
    await page.keyboard.press('Escape');
    await expect(page.locator('.p-colorpicker-panel')).toBeHidden();
    await toolbar.getByTestId('drawing-options-toggle').click();
    await expect(page.getByTestId('drawing-options').getByLabel('Unit')).toBeInViewport();
    await page.getByTestId('drawing-options').getByLabel('Unit').press('Escape');
    await expect(page.getByTestId('drawing-options')).toBeHidden();
    await expect(toolbar.getByRole('button', {name: 'Finish', exact: true})).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({path: testInfo.outputPath('drawing-toolbar-narrow.png')});
    await toolbar.getByTestId('drawing-toolbar-close').click();
    await expect(toolbar).toBeHidden();
});
