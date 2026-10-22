import {patchAppState, withPersistedState} from "../shared/persisted-state";
import {signalStoreFeature, withMethods} from "@ngrx/signals";
import {z} from "zod";
import {AppStateOptions, Boolish} from "../shared/state-value";
import type {DiagnosticsExportOptions, DiagnosticsLogFilter} from "./diagnostics.model";

interface DiagnosticsValues {
    logFilter: DiagnosticsLogFilter;
    exportOptions: DiagnosticsExportOptions;
}

/** The log dialog keeps its existing level filter when saved browser state is restored. */
export const diagnosticsLogFilter: AppStateOptions<DiagnosticsLogFilter> = {
    name: "diagnosticsLogFilter",
    defaultValue: {info: true, warn: true, error: true},
    schema: z.object({info: Boolish, warn: Boolish, error: Boolish})
};

export const diagnosticsExportOptions: AppStateOptions<DiagnosticsExportOptions> = {
    name: "diagnosticsExportOptions",
    defaultValue: {
        includeProgress: true,
        includePerformance: true,
        includeLogs: true,
        logFilter: {info: true, warn: true, error: true}
    },
    schema: z.object({
        includeProgress: Boolish,
        includePerformance: Boolish,
        includeLogs: Boolish,
        logFilter: z.object({info: Boolish, warn: Boolish, error: Boolish})
    })
};

/**
 * The log and export dialogs read these signals for their selected options.
 * DiagnosticsFacadeService still gathers live logs and performance counters;
 * changing a preference here publishes the complete dialog choice once.
 */
export function withDiagnosticsState() {
    return signalStoreFeature(
        withPersistedState<"diagnostics", DiagnosticsValues>("diagnostics", {
            logFilter: diagnosticsLogFilter,
            exportOptions: diagnosticsExportOptions
        }),
        withMethods(store => ({
            setDiagnosticsLogFilter(logFilter: DiagnosticsLogFilter): void {
                patchAppState(store, {
                    diagnostics: {...store.diagnostics(), logFilter: {...logFilter}}
                });
            },
            setDiagnosticsExportOptions(exportOptions: DiagnosticsExportOptions): void {
                const next = {...exportOptions, logFilter: {...exportOptions.logFilter}};
                patchAppState(store, {
                    diagnostics: {...store.diagnostics(), exportOptions: next}
                });
            }
        }))
    );
}
