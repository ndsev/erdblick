/**
 * Saved log filters, export preferences and non-persisted runtime version metadata.
 * Observing these AppStates does not start diagnostic collection; collecting, formatting
 * and exporting reports remain in DiagnosticsFacadeService.
 */
import { Injectable } from "@angular/core";
import { z } from "zod";
import { BehaviorSubject } from "rxjs";
import type { RuntimeVersions } from "./version.model";
import { Boolish } from "../appstate/appstate";
import { AppStateService } from "../appstate/appstate.service";
import type { DiagnosticsExportOptions, DiagnosticsLogFilter } from "./diagnostics.model";

@Injectable({ providedIn: "root" })
export class DiagnosticsState {
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

    /** Runtime metadata is published separately from persisted diagnostic preferences. */
    private readonly runtimeVersions = new BehaviorSubject<RuntimeVersions>(Object.freeze({
        distributionVersions: Object.freeze([]),
        erdblickVersion: ""
    }));

    readonly versions$ = this.runtimeVersions.asObservable();

    get versions(): RuntimeVersions {
        return this.runtimeVersions.value;
    }

    /**
     * Startup supplies the running deployment's labels. Freeze a copy so About
     * and diagnostic exports can retain a snapshot without mutating one another.
     * Unlike AppStates, these labels are never restored from browser storage.
     */
    setRuntimeVersions(versions: RuntimeVersions): void {
        this.runtimeVersions.next(Object.freeze({
            distributionVersions: Object.freeze(versions.distributionVersions.map(version => Object.freeze({ ...version }))),
            erdblickVersion: versions.erdblickVersion
        }));
    }
}
