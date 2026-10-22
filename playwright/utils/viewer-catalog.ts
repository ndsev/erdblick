import {readFileSync} from 'node:fs';
import {expect} from '@playwright/test';
import {z} from 'zod';
import type {createControlActions} from '../../app/actions/control-actions';
import type {viewerUiActions} from '../../app/actions/viewer-ui-actions.store-feature';
import type {diagnosticsActions} from '../../app/diagnostics/diagnostics-actions.store-feature';
import type {inspectionActions} from '../../app/inspection/inspection-actions.store-feature';
import type {mapInfoActions} from '../../app/mapdata/map-info-actions.store-feature';
import type {mapViewActions} from '../../app/mapview/map-view-actions.store-feature';
import type {featureSearchActions} from '../../app/search/feature-search-actions.store-feature';
import type {appActions} from '../../app/shared/app-actions.store-feature';
import type {AppStore} from '../../app/shared/app.store';
import type {styleActions} from '../../app/styledata/style-actions.store-feature';

/**
 * Keep workflow assertions typed without importing Angular resource owners into
 * Playwright's Node process. This is only a set of result types used by tests;
 * discovery and the public allowlist below come from the shipped artifact.
 */
type ResourceActions = typeof appActions & typeof mapInfoActions & typeof mapViewActions &
    typeof inspectionActions & typeof featureSearchActions & typeof styleActions &
    typeof diagnosticsActions & typeof viewerUiActions;
type GenericControls = ReturnType<typeof createControlActions>;
type ActionResults = {
    [Key in keyof ResourceActions as ResourceActions[Key]['name']]: z.output<ResourceActions[Key]['outputSchema']>;
} & {
    viewer_describe_controls: z.output<GenericControls['describeControls']['outputSchema']>;
    viewer_get_controls: z.output<GenericControls['getControls']['outputSchema']>;
    viewer_set_control: z.output<GenericControls['setControl']['outputSchema']>;
    viewer_close_inspection: ReturnType<AppStore['closeInspection']>;
};
export type ViewerActionName = keyof ActionResults;
type ViewerActionOutput<Name extends ViewerActionName> = ActionResults[Name];

/** The shipped wire artifact is safe to read in Playwright's Node process; owner classes stay in the browser. */
export const viewerCatalog = JSON.parse(readFileSync('static/browser/web-mcp-actions.json', 'utf8')) as {
    actions: Array<{name: ViewerActionName; mutation: boolean}>;
    channels: Array<{name: string; valueSchema: z.core.JSONSchema.JSONSchema}>;
};
export const viewerActionNames = viewerCatalog.actions.map(action => action.name);

/**
 * Read the same public value schema that mapget loads. Individual browser tests
 * can assert camera or panel values without loading the feature implementation.
 */
export function viewerControlSchema<Value>(name: string): z.ZodType<Value> {
    const declaration = viewerCatalog.channels.find(control => control.name === name);
    if (!declaration) throw new Error(`Unknown shipped control: ${name}`);
    return z.fromJSONSchema(declaration.valueSchema) as z.ZodType<Value>;
}

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
