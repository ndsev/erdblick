import type {Page} from '@playwright/test';
import {expect, test} from '../fixtures/test';
import {navigateToRoot, waitForAppReady} from '../utils/ui-helpers';

interface PayloadRequest {
    clientId: string;
    signal: AbortSignal | null | undefined;
}

interface UnloadSnapshot {
    count: number;
    aborted: boolean;
}

declare global {
    interface Window {
        __erdblickPayloadRequests?: PayloadRequest[];
        __recordPayloadUnload?: (snapshot: UnloadSnapshot) => Promise<void>;
    }
}

test.use({stateSnapshot: null});

/** Observes the application's actual fetch signals without mocking responses or promise handling. */
async function observePayloadRequests(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const requests: PayloadRequest[] = [];
        window.__erdblickPayloadRequests = requests;
        const fetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input), document.baseURI);
            if (url.pathname === '/interactive/payload') {
                requests.push({clientId: url.searchParams.get('clientId')!, signal: init?.signal});
            }
            return fetch(input, init);
        };
    });
}

/** Waits for a live payload request from a session other than those already observed. */
async function waitForPayloadSession(page: Page, previous: string[] = []): Promise<string[]> {
    const readClients = () => page.evaluate(excluded => [...new Set(
        (window.__erdblickPayloadRequests ?? [])
            .filter(request => !request.signal?.aborted && !excluded.includes(request.clientId))
            .map(request => request.clientId)
    )], previous);
    await expect.poll(readClients).not.toEqual([]);
    return readClients();
}

test('payload transport survives cancelled navigation and page-cache lifecycle events', async ({page}) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await observePayloadRequests(page);
    await navigateToRoot(page);
    const initialClients = await waitForPayloadSession(page);

    const cancelledUnload = await page.evaluate(() => {
        window.dispatchEvent(new Event('beforeunload', {cancelable: true}));
        const requests = window.__erdblickPayloadRequests!;
        return {count: requests.length, aborted: requests.every(request => request.signal?.aborted)};
    });
    expect(cancelledUnload.count).toBeGreaterThan(0);
    expect(cancelledUnload.aborted).toBe(true);
    const resumedClients = await waitForPayloadSession(page, initialClients);

    const cached = await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
        return window.__erdblickPayloadRequests!.every(request => request.signal?.aborted);
    });
    expect(cached).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true})));
    await waitForPayloadSession(page, [...initialClients, ...resumedClients]);
    expect(errors).toEqual([]);
});

test('reload cancels live payload requests before leaving the document', async ({page}) => {
    const errors: string[] = [];
    const unloads: UnloadSnapshot[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__recordPayloadUnload', (snapshot: UnloadSnapshot) => {unloads.push(snapshot);});
    await observePayloadRequests(page);
    await navigateToRoot(page);
    await waitForPayloadSession(page);
    await page.evaluate(() => {
        // Register after application startup so its earlier cancellation handler has run.
        window.addEventListener('beforeunload', () => {
            const requests = window.__erdblickPayloadRequests!;
            void window.__recordPayloadUnload!({
                count: requests.length,
                aborted: requests.every(request => request.signal?.aborted)
            });
        }, {once: true});
    });

    await page.reload();
    await waitForAppReady(page);
    await waitForPayloadSession(page);

    await expect.poll(() => unloads.length).toBe(1);
    expect(unloads[0].count).toBeGreaterThan(0);
    expect(unloads[0].aborted).toBe(true);
    expect(errors).toEqual([]);
});
