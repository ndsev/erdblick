import {inject, Injector} from "@angular/core";
import {signalStoreFeature, withMethods} from "@ngrx/signals";
import {z} from "zod";
import {action} from "../actions/action";
import {bounded, identifierSchema, limit, observed, text} from "../actions/action-schema";
import {viewIdSchema} from "../mapview/view-id";
import {DiagnosticsFacadeService} from "./diagnostics.facade.service";

/** Bounded browser diagnostics contract, implemented by the runtime diagnostics owner. */
export const diagnosticsActions = {
    viewer_get_diagnostics: {
        name: "viewer_get_diagnostics",
        description:
            "Read BROWSER transport, render-worker queues, frame-time metrics, cached loading, GPU allocation and style/search errors without resetting the view. Native BACKEND workers/cache/memory require the separately privileged mapget_get_diagnostics tool. Call it only when it appears in your tool catalog; otherwise explain the permission limit. Browser workers and observed transport latency are not backend queue statistics. No scene/tile scan or GPU readback. Cached and unavailable metrics are explicit.",
        mutation: false,
        inputSchema: z.strictObject({
            viewId: viewIdSchema.optional(),
            mapId: identifierSchema.optional(),
            layerId: identifierSchema.optional(),
            sections: z
                .array(z.enum(["transport", "workers", "loading", "gpu", "errors"]))
                .max(5)
                .optional(),
            limit
        }),
        outputSchema: z.strictObject({
            ...observed,
            ...bounded,
            executionContext: z.literal("browser"),
            interpretation: text,
            metrics: z
                .array(
                    z.strictObject({
                        section: text,
                        name: text,
                        value: z.union([z.number(), z.boolean(), z.null()]),
                        scope: z.enum(["tab", "view"]),
                        viewId: viewIdSchema.optional(),
                        cached: z.boolean().optional()
                    })
                )
                .max(100),
            errors: z
                .array(
                    z.strictObject({
                        source: text,
                        message: text,
                        severity: z.enum(["warning", "error"]).optional(),
                        phase: text.optional(),
                        property: text.optional(),
                        expression: text.optional(),
                        rulePath: text.optional(),
                        mapId: identifierSchema.optional(),
                        layerId: identifierSchema.optional(),
                        featureId: identifierSchema.optional()
                    })
                )
                .max(100),
            unavailable: z.array(text).max(20)
        })
    }
} as const;

export type DiagnosticsInput = z.infer<typeof diagnosticsActions.viewer_get_diagnostics.inputSchema>;
export type DiagnosticsOutput = z.infer<typeof diagnosticsActions.viewer_get_diagnostics.outputSchema>;

/** Catalog construction does not start diagnostics sampling or resolve its render and transport dependencies. */
export function withDiagnosticsActions() {
    return signalStoreFeature(withMethods(() => {
        const injector = inject(Injector);
        const owner = () => injector.get(DiagnosticsFacadeService);
        return {
            getDiagnostics: action(diagnosticsActions.viewer_get_diagnostics, (input): DiagnosticsOutput =>
                owner().getDiagnostics(input))
        };
    }));
}
