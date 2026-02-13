import {Component, Input} from '@angular/core';
import {ProgressCounter, TilePipelineProgress} from './diagnostics.model';

interface ProgressStage {
    key: keyof TilePipelineProgress;
    label: string;
}

@Component({
    selector: 'diagnostics-progress',
    template: `
        <div class="diagnostics-progress-list">
            @for (stage of progressStages; track stage.key) {
                <div class="diagnostics-progress-item">
                    <span class="diagnostics-stage-label">{{ stage.label }}</span>
                    <p-progressBar [value]="progressPercent(progress[stage.key])" [showValue]="false"></p-progressBar>
                    <span class="diagnostics-stage-count">{{ progress[stage.key].done }} / {{ progress[stage.key].total }}</span>
                </div>
            }
        </div>
    `,
    styles: [``],
    standalone: false
})
export class DiagnosticsProgressComponent {
    @Input({required: true}) progress!: TilePipelineProgress;

    readonly progressStages: ProgressStage[] = [
        {key: 'requested', label: 'Requested'},
        {key: 'fetched', label: 'Fetched'},
        {key: 'converted', label: 'Converted'},
        {key: 'rendered', label: 'Rendered'}
    ];

    progressPercent(counter: ProgressCounter): number {
        if (!counter.total) {
            return 0;
        }
        if (counter.done >= counter.total) {
            return 100;
        }
        const percent = Math.floor((counter.done / counter.total) * 100);
        return Math.max(0, Math.min(99, percent));
    }
}
