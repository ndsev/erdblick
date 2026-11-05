/**
 * Collect the same registrations as browser startup and the catalog build.
 * Angular constructs real owners, but no runtime initializer, state reader or
 * action is invoked. The generated types describe those collected schemas;
 * this fixture contains no independent list of actions or controls.
 */
import "@angular/compiler";
import { APP_BASE_HREF } from "@angular/common";
import { provideHttpClient } from "@angular/common/http";
import { provideZonelessChangeDetection } from "@angular/core";
import { createApplication } from "@angular/platform-browser";
import { provideRouter } from "@angular/router";
import { MessageService } from "primeng/api";
import type { z } from "zod";
import { beforeAll } from "vitest";
import type { AppActionRegistry } from "../../app/action/action-registry.service";
import type { AppAction, AppControl } from "../../app/action/action.model";
import type { ViewerContract } from "../../app/action/generated/viewer-contract";
import { registerApplication } from "../../app/application-registration";

export type ViewerActionName = keyof ViewerContract["actions"];
export type ViewerActionInput<Name extends ViewerActionName> = ViewerContract["actions"][Name]["input"];
export type ViewerActionOutput<Name extends ViewerActionName> = ViewerContract["actions"][Name]["output"];

/** Registration erases heterogeneous generics; the build restores their named public types. */
export let viewerActions: {
    [Name in ViewerActionName]: AppAction<z.ZodType<ViewerActionInput<Name>>, z.ZodType<ViewerActionOutput<Name>>>;
};
export let applicationControls: {
    [Name in keyof ViewerContract["controls"]]: AppControl<z.ZodObject, z.ZodType<ViewerContract["controls"][Name]["value"]>>;
};
let catalog: ReturnType<AppActionRegistry["catalog"]>;

beforeAll(async () => {
    const application = await createApplication({ providers: [
        provideZonelessChangeDetection(), provideHttpClient(), provideRouter([]),
        { provide: APP_BASE_HREF, useValue: "/" }, MessageService
    ] });
    try {
        const registry = registerApplication(application.injector);
        catalog = registry.catalog();
        viewerActions = registry.publicActions as typeof viewerActions;
        applicationControls = Object.fromEntries(registry.publicControls.map(control => [control.name, control])) as typeof applicationControls;
    } finally {
        application.destroy();
    }
});

/** Each assertion receives detached metadata, so sorting cannot affect another test. */
export function viewerActionCatalog() {
    return structuredClone(catalog);
}

export { canonicalViewerContractJson } from "../../app/action/catalog-json.util";
export { viewerJsonSchema } from "../../app/action/control-actions.util";
export { VIEWER_ACTION_INVOCATION_BYTES, VIEWER_ACTION_RESULT_BYTES, VIEWER_ACTION_TARGET_LIMIT } from "../../app/action/action.model";
