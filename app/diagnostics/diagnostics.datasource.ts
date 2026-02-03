import {InjectionToken} from '@angular/core';
import {Observable} from 'rxjs';
import {DiagnosticsSnapshot, LogEntry, PerfStat} from './diagnostics.model';

export interface DiagnosticsDataSource {
    readonly snapshot$: Observable<DiagnosticsSnapshot>;
    readonly perfStats$: Observable<PerfStat[]>;
    readonly logs$: Observable<LogEntry[]>;
}

export const DIAGNOSTICS_DATA_SOURCE = new InjectionToken<DiagnosticsDataSource>('DiagnosticsDataSource');
