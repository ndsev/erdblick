import {signalStoreFeature, withState} from "@ngrx/signals";
import {z} from "zod";
import {AppStateOptions, Boolish, deepCopy} from "../shared/state-value";
import type {DiagnosticsExportOptions, DiagnosticsLogFilter} from "./diagnostics.model";

/** Storage keys stay unchanged when their values move to the diagnostics owner. */
export const diagnosticsLogFilter: AppStateOptions<DiagnosticsLogFilter> = {
    name: "diagnosticsLogFilter",
    defaultValue: {info: true, warn: true, error: true},
    schema: z.object({info: Boolish, warn: Boolish, error: Boolish})
};

export const diagnosticsExportOptions: AppStateOptions<DiagnosticsExportOptions> = {
    name: "diagnosticsExportOptions",
    defaultValue: {
        includeProgress: true, includePerformance: true, includeLogs: true,
        logFilter: {info: true, warn: true, error: true}
    },
    schema: z.object({
        includeProgress: Boolish, includePerformance: Boolish, includeLogs: Boolish,
        logFilter: z.object({info: Boolish, warn: Boolish, error: Boolish})
    })
};

/** The shared store composes this owner-authored feature; it adds no diagnostics behavior. */
export function withDiagnosticsState() {
    return signalStoreFeature(withState({diagnostics: {
        logFilter: deepCopy(diagnosticsLogFilter.defaultValue),
        exportOptions: deepCopy(diagnosticsExportOptions.defaultValue)
    }}));
}
