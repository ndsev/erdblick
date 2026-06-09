import {AfterViewInit, Component, ElementRef, EventEmitter, Input, OnDestroy, Output, ViewChild} from "@angular/core";
import {NgClass} from "@angular/common";
import {ProgressSpinnerModule} from "primeng/progressspinner";
import {CompletionCandidate} from "./search.model";

@Component({
    selector: "search-completion-popup",
    template: `
        <div #popup
             class="completion-popup search-completion-popup"
             [class.completion-popup-hidden]="!(visible || pending)"
             (mousedown)="popupMouseDown.emit($event)"
             [style.top.px]="top"
             [style.left.px]="left"
             [style.z-index]="zIndex">
            @for (item of items; track $index) {
                <div [ngClass]="{'selected': $index === selectionIndex}"
                     (click)="candidateSelected.emit(item)">
                    <div class="row">
                        <span>{{ item.text }}</span><span class="type">({{ item.kind }})</span>
                    </div>
                    @if (item.hint) {
                        <div class="row hint">
                            {{ item.hint }}
                        </div>
                    }
                </div>
            }
            @if (pending) {
                <p-progress-spinner aria-label="Loading completion candidates"
                                    [style]="{ height: '1em', width: '1em' }" />
            }
        </div>
    `,
    standalone: true,
    imports: [NgClass, ProgressSpinnerModule]
})
/** Shared popup renderer for Simfil completion candidates. */
export class SearchCompletionPopupComponent implements AfterViewInit, OnDestroy {
    @ViewChild("popup", {static: true}) private popup!: ElementRef<HTMLElement>;

    @Input() visible = false;
    @Input() pending = false;
    @Input() items: CompletionCandidate[] = [];
    @Input() selectionIndex = 0;
    @Input() top = 0;
    @Input() left = 0;
    @Input() zIndex = 0;

    @Output() popupMouseDown = new EventEmitter<MouseEvent>();
    @Output() candidateSelected = new EventEmitter<CompletionCandidate>();

    /** Moves the fixed-position popup out of floating dialogs so z-index and clipping are predictable. */
    ngAfterViewInit(): void {
        document.body.appendChild(this.popup.nativeElement);
    }

    /** Removes the body-mounted popup explicitly because Angular no longer owns its original DOM position. */
    ngOnDestroy(): void {
        this.popup.nativeElement.remove();
    }
}
