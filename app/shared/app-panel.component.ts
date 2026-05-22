import {NgClass, NgStyle, NgTemplateOutlet} from '@angular/common';
import {
    AfterViewInit,
    Component,
    ContentChild,
    ElementRef,
    EventEmitter,
    Input,
    OnChanges,
    Output,
    SimpleChanges,
    TemplateRef,
    ViewChild
} from '@angular/core';
import {AccordionModule} from 'primeng/accordion';
import {AppStateService} from './appstate.service';

export type AppPanelResizeMode = 'none' | 'vertical' | 'fill' | 'auto';

@Component({
    selector: 'app-panel',
    host: {
        class: 'app-panel-host'
    },
    template: `
        <div #container class="app-panel"
             [ngClass]="[styleClass, resizeModeClass, panelCountClass, expandedClass]"
             [ngStyle]="style"
             (pointerdown)="focusRequest.emit($event)"
             (focusin)="focusRequest.emit($event)">
            <p-accordion class="app-panel-accordion"
                         [ngClass]="styleClass"
                         [(value)]="accordionValue"
                         [transitionOptions]="transitionOptions"
                         (valueChange)="handleAccordionValueChange($event)">
                <p-accordion-panel value="0">
                    <p-accordion-header (pointerdown)="headerPointerDown.emit($event)">
                        @if (projectedHeaderTemplate) {
                            <ng-container *ngTemplateOutlet="projectedHeaderTemplate"></ng-container>
                        } @else {
                            <span class="app-panel-title">{{ header }}</span>
                        }
                    </p-accordion-header>
                    <p-accordion-content>
                        <div class="app-panel-content"
                             [ngClass]="contentStyleClass"
                             [ngStyle]="contentStyle">
                            @if (projectedContentTemplate) {
                                <ng-container *ngTemplateOutlet="projectedContentTemplate"></ng-container>
                            }
                            <ng-content></ng-content>
                        </div>
                    </p-accordion-content>
                </p-accordion-panel>
            </p-accordion>
            @if (projectedFooterTemplate) {
                <div class="app-panel-footer">
                    <ng-container *ngTemplateOutlet="projectedFooterTemplate"></ng-container>
                </div>
            }
        </div>
    `,
    standalone: true,
    imports: [AccordionModule, NgClass, NgStyle, NgTemplateOutlet]
})
/** Generic docked surface wrapper backed by a single PrimeNG accordion item. */
export class AppPanelComponent implements AfterViewInit, OnChanges {
    @ContentChild('header', {descendants: true, read: TemplateRef}) projectedHeaderTemplate?: TemplateRef<unknown>;
    @ContentChild('content', {descendants: true, read: TemplateRef}) projectedContentTemplate?: TemplateRef<unknown>;
    @ContentChild('footer', {descendants: true, read: TemplateRef}) projectedFooterTemplate?: TemplateRef<unknown>;

    @Input() header = '';
    @Input() collapsed = false;
    @Output() collapsedChange = new EventEmitter<boolean>();

    @Input() layoutId?: string;
    @Input() persistLayout = false;
    @Input() style: {[key: string]: any} = {};
    @Input() styleClass = '';
    @Input() contentStyle: {[key: string]: any} = {};
    @Input() contentStyleClass = '';
    @Input() resizeMode: AppPanelResizeMode = 'auto';
    @Input() dockedPanelCount = 1;
    @Input() expanded = false;
    @Input() transitionOptions = '320ms cubic-bezier(0.22, 1, 0.36, 1)';

    @Output() onShow = new EventEmitter<void>();
    @Output() onHide = new EventEmitter<void>();
    @Output() focusRequest = new EventEmitter<Event>();
    @Output() headerPointerDown = new EventEmitter<PointerEvent>();

    @ViewChild('container') private containerRef?: ElementRef<HTMLElement>;

    protected accordionValue: string | null = '0';

    constructor(private readonly stateService: AppStateService) {}

    /** Applies persisted collapse state and input changes to the accordion value. */
    ngOnChanges(changes: SimpleChanges): void {
        if (changes['layoutId'] || changes['persistLayout'] || changes['collapsed']) {
            const persisted = this.persistLayout && this.layoutId
                ? this.stateService.getDialogLayout(this.layoutId)?.panelCollapsed
                : undefined;
            this.applyCollapsed(persisted ?? this.collapsed);
        }
    }

    /** Emits an initial show event once the docked surface is measurable. */
    ngAfterViewInit(): void {
        this.onShow.emit();
    }

    /** Returns the docked panel host element. */
    container(): HTMLElement | undefined {
        return this.containerRef?.nativeElement;
    }

    protected get resizeModeClass(): string {
        const effectiveResizeMode = this.resizeMode === 'auto'
            ? (this.dockedPanelCount <= 1 ? 'fill' : 'vertical')
            : this.resizeMode;
        return `app-panel-resize-${effectiveResizeMode}`;
    }

    protected get panelCountClass(): string {
        return this.dockedPanelCount <= 1 ? 'app-panel-single' : 'app-panel-stack';
    }

    protected get expandedClass(): string {
        return this.expanded ? 'app-panel-expanded' : 'app-panel-default-size';
    }

    /** Persists and emits accordion collapse changes. */
    protected handleAccordionValueChange(value: string | number | string[] | number[] | null | undefined): void {
        const nextCollapsed = value !== '0';
        this.collapsed = nextCollapsed;
        if (this.persistLayout && this.layoutId) {
            this.stateService.setPanelLayout(this.layoutId, {panelCollapsed: nextCollapsed});
        }
        this.collapsedChange.emit(nextCollapsed);
        if (nextCollapsed) {
            this.onHide.emit();
        } else {
            this.onShow.emit();
        }
    }

    private applyCollapsed(collapsed: boolean): void {
        this.collapsed = collapsed;
        this.accordionValue = collapsed ? null : '0';
    }
}
