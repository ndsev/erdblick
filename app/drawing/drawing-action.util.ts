import {z} from 'zod';
import type {AppActionRegistration} from '../action/action-contributor.model';
import {rejectAction} from '../action/action.model';
import {ViewerActionFailure} from '../action/viewer-action-relay.contract';

export const drawingPositionSchema = z.array(z.number().finite()).min(2).max(3);

/** Normalize domain diagnostics once for local, relay and document adapters. */
export function drawingActions(registry: AppActionRegistration): AppActionRegistration {
    return {
        registerControl: (declaration, binding) => registry.registerControl(declaration, binding),
        registerAction: (declaration, execute, candidates) => registry.registerAction(declaration, async (input, signal) => {
            if (signal?.aborted) rejectAction('Drawing operation cancelled.', 'cancelled', 'cancelled');
            try { return await execute(input, signal); }
            catch (error) {
                if (error instanceof ViewerActionFailure) throw error;
                if (error instanceof DOMException && error.name === 'AbortError')
                    rejectAction('Drawing operation cancelled before publication.', 'cancelled', 'cancelled');
                const message = error instanceof Error ? error.message : String(error);
                if (/revision|changed.*(read|editing|save)|[Ss]tale/.test(message)) rejectAction(message, 'busy', 'stale_revision');
                if (/quota|storage|browser copy/i.test(message)) rejectAction(message, 'not_available', 'storage_unavailable');
                if (/busy|idle|valid.*document|saving/.test(message)) rejectAction(message, 'busy', 'document_busy');
                if (/not found|no longer exists|missing|expired/i.test(message)) rejectAction(message, 'not_available', 'missing_target');
                if (/view|Mercator|authoring space/i.test(message)) rejectAction(message, 'not_available', 'view_unavailable');
                rejectAction(message, 'invalid_arguments', 'drawing_validation');
            }
        }, candidates)
    };
}
