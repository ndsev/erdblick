/**
 * Saved log filters and export preferences for the diagnostics UI. Observing
 * these AppStates does not start diagnostic collection; collecting, formatting
 * and exporting reports remain in DiagnosticsFacadeService.
 */
import { Injectable } from "@angular/core";
import { z } from "zod";
import { Boolish } from "../state/app-state";
import { AppStateService } from "../state/app-state.service";
import type { DiagnosticsExportOptions, DiagnosticsLogFilter } from "./diagnostics.types";

@Injectable({ providedIn: "root" })
export class DiagnosticsModel {
    constructor(private readonly persistence: AppStateService) {}

    readonly diagnosticsLogFilterState = this.persistence.registerState<DiagnosticsLogFilter>({
        name: "diagnosticsLogFilter",
        defaultValue: {
            info: true,
            warn: true,
            error: true
        },
        schema: z.object({
            info: Boolish,
            warn: Boolish,
            error: Boolish
        })
    });

    readonly diagnosticsExportOptionsState = this.persistence.registerState<DiagnosticsExportOptions>({
        name: "diagnosticsExportOptions",
        defaultValue: {
            includeProgress: true,
            includePerformance: true,
            includeLogs: true,
            logFilter: {
                info: true,
                warn: true,
                error: true
            }
        },
        schema: z.object({
            includeProgress: Boolish,
            includePerformance: Boolish,
            includeLogs: Boolish,
            logFilter: z.object({
                info: Boolish,
                warn: Boolish,
                error: Boolish
            })
        })
    });

    get diagnosticsLogFilter() {
        return this.diagnosticsLogFilterState.getValue();
    }

    set diagnosticsLogFilter(val: DiagnosticsLogFilter) {
        this.diagnosticsLogFilterState.next({ ...val });
    }

    get diagnosticsExportOptions() {
        return this.diagnosticsExportOptionsState.getValue();
    }

    set diagnosticsExportOptions(val: DiagnosticsExportOptions) {
        this.diagnosticsExportOptionsState.next({
            ...val,
            logFilter: { ...val.logFilter }
        });
    }
}
