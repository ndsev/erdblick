import {readFileSync} from 'node:fs';
import {expect} from '@playwright/test';
import type {ViewerActionName, ViewerActionOutput} from '../../app/actions/viewer-action.contract';

/** The shipped wire artifact is safe to read in Playwright's Node process; owner classes stay in the browser. */
export const viewerCatalog = JSON.parse(readFileSync('static/browser/web-mcp-actions.json', 'utf8')) as {
    actions: Array<{name: ViewerActionName; mutation: boolean}>;
};
export const viewerActionNames = viewerCatalog.actions.map(action => action.name);
export type {ViewerActionName};

/** Native MCP validates the full result schema. Browser assertions below check the actual workflow values. */
export function viewerResult<Name extends ViewerActionName>(name: Name, value: unknown): ViewerActionOutput<Name> {
    expect(viewerActionNames).toContain(name);
    expect(typeof value).toBe('object');
    expect(value).not.toBeNull();
    return value as ViewerActionOutput<Name>;
}

/** Fail clearly when a live control is unavailable instead of treating it as an empty value. */
export function availableValue(entry: ViewerActionOutput<'viewer_get_controls'>['values'][number]): unknown {
    expect(entry).toHaveProperty('value');
    if (!('value' in entry)) throw new Error(`Control unavailable: ${entry.unavailable}`);
    return entry.value;
}
