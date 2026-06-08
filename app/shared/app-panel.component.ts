import {NgClass, NgStyle, NgTemplateOutlet} from '@angular/common';
import {
    AfterViewInit,
    Component,
    ContentChild,
    ElementRef,
    EventEmitter,
    HostBinding,
    Input,
    OnChanges,
    Output,
    SimpleChanges,
    TemplateRef,
    ViewChild
} from '@angular/core';
import {AccordionModule} from 'primeng/accordion';
import {AppStateService, DEFAULT_DOCKED_EM_HEIGHT} from './appstate.service';

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
                        <div #contentContainer
                             class="app-panel-content"
                             [class.app-panel-content-fixed]="usesFixedBody"
                             [class.app-panel-content-resizable]="contentResizable"
                             [ngClass]="contentStyleClass"
                             [ngStyle]="contentStyle"
                             [style.height.px]="fixedBodyHeightPx"
                             (mouseup)="handleContentResizeEnd()">
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
    @Input() defaultBodyHeightEm = DEFAULT_DOCKED_EM_HEIGHT;
    @Input() minBodyHeightEm = 15;
    @Input() maxBodyHeightEm?: number;
    @Input() preferredBodyHeightEm?: number | (() => number | undefined);
    @Input() transitionOptions = '320ms cubic-bezier(0.22, 1, 0.36, 1)';

    @Output() onShow = new EventEmitter<void>();
    @Output() onHide = new EventEmitter<void>();
    @Output() expandedChange = new EventEmitter<boolean>();
    @Output() bodySizeChange = new EventEmitter<void>();
    @Output() focusRequest = new EventEmitter<Event>();
    @Output() headerPointerDown = new EventEmitter<PointerEvent>();

    @ViewChild('container') private containerRef?: ElementRef<HTMLElement>;
    @ViewChild('contentContainer') private contentRef?: ElementRef<HTMLElement>;

    protected accordionValue: string | null = '0';
    private panelBodyHeightPx?: number;
    private viewInitialized = false;

    constructor(private readonly stateService: AppStateService) {}

    /** Applies persisted panel state and input changes to the accordion value and dock body size. */
    ngOnChanges(changes: SimpleChanges): void {
        if (changes['layoutId']
            || changes['persistLayout']
            || changes['collapsed']
            || changes['expanded']
            || changes['resizeMode']
            || changes['dockedPanelCount']
            || changes['defaultBodyHeightEm']
            || changes['minBodyHeightEm']
            || changes['maxBodyHeightEm']) {
            this.syncPanelLayout();
        }
    }

    /** Emits an initial show event once the docked surface is measurable. */
    ngAfterViewInit(): void {
        this.viewInitialized = true;
        this.syncPanelLayout();
        this.onShow.emit();
        this.scheduleBodySizeChange();
    }

    /** Returns the docked panel host element. */
    container(): HTMLElement | undefined {
        return this.containerRef?.nativeElement;
    }

    @HostBinding('class.app-panel-host-single')
    protected get hostSingleClass(): boolean {
        return this.dockedPanelCount <= 1;
    }

    @HostBinding('class.app-panel-host-stack')
    protected get hostStackClass(): boolean {
        return this.dockedPanelCount > 1;
    }

    protected get resizeModeClass(): string {
        return `app-panel-resize-${this.effectiveResizeMode}`;
    }

    protected get panelCountClass(): string {
        return this.dockedPanelCount <= 1 ? 'app-panel-single' : 'app-panel-stack';
    }

    protected get expandedClass(): string {
        return this.expanded ? 'app-panel-expanded' : 'app-panel-default-size';
    }

    protected get fixedBodyHeightPx(): number | null {
        if (!this.usesFixedBody) {
            return null;
        }
        return this.panelBodyHeightPx ?? this.defaultBodyHeightPx();
    }

    protected get usesFixedBody(): boolean {
        return this.effectiveResizeMode === 'vertical';
    }

    protected get contentResizable(): boolean {
        return this.usesFixedBody && !this.collapsed;
    }

    private get effectiveResizeMode(): Exclude<AppPanelResizeMode, 'auto'> {
        return this.resizeMode === 'auto'
            ? (this.dockedPanelCount <= 1 ? 'fill' : 'vertical')
            : this.resizeMode;
    }

    /** Switches a docked stacked panel between default height and preferred content height. */
    toggleExpanded(): void {
        if (!this.usesFixedBody) {
            return;
        }
        if (this.expanded) {
            this.shrinkToDefaultHeight();
        } else {
            this.expandToPreferredHeight();
        }
    }

    /** Recomputes the expanded height after projected content changes. */
    refreshExpandedHeight(): void {
        if (!this.usesFixedBody || !this.expanded) {
            this.scheduleBodySizeChange();
            return;
        }
        this.expandToPreferredHeight();
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

    /** Applies stored generic dock-panel layout when available. */
    private syncPanelLayout(): void {
        const layout = this.persistLayout && this.layoutId
            ? this.stateService.getDialogLayout(this.layoutId)
            : undefined;
        this.applyCollapsed(layout?.panelCollapsed ?? this.collapsed);
        const nextExpanded = layout?.panelExpanded ?? this.expanded;
        this.applyExpanded(nextExpanded);
        const storedHeight = layout?.panelSize?.height;
        const hasStoredHeight = Number.isFinite(storedHeight) && storedHeight! > 0;
        this.panelBodyHeightPx = hasStoredHeight
            ? this.clampBodyHeightPx(storedHeight!)
            : this.seedBodyHeightPx(nextExpanded);
        if (!hasStoredHeight && this.viewInitialized && this.usesFixedBody) {
            this.persistBodyLayout();
        }
        this.scheduleBodySizeChange();
    }

    private expandToPreferredHeight(): void {
        const preferredHeight = this.preferredBodyHeightPx()
            ?? this.measuredContentHeightPx()
            ?? this.defaultBodyHeightPx();
        const currentHeight = this.fixedBodyHeightPx ?? this.defaultBodyHeightPx();
        this.applyBodyLayout(
            Math.max(this.minBodyHeightPx(), currentHeight, preferredHeight),
            true
        );
    }

    private shrinkToDefaultHeight(): void {
        this.applyBodyLayout(this.defaultBodyHeightPx(), false);
    }

    protected handleContentResizeEnd(): void {
        if (!this.contentResizable) {
            return;
        }
        const content = this.contentRef?.nativeElement;
        if (!content) {
            return;
        }
        const nextHeight = content.getBoundingClientRect().height;
        if (!Number.isFinite(nextHeight) || nextHeight <= 0) {
            return;
        }
        if (Math.abs(nextHeight - (this.panelBodyHeightPx ?? 0)) < 1) {
            return;
        }
        this.applyBodyLayout(nextHeight, nextHeight > this.defaultBodyHeightPx() + 1);
    }

    private applyBodyLayout(heightPx: number, expanded: boolean): void {
        if (!Number.isFinite(heightPx) || heightPx <= 0) {
            return;
        }
        this.panelBodyHeightPx = this.clampBodyHeightPx(heightPx);
        this.applyExpanded(expanded);
        this.persistBodyLayout();
        this.scheduleBodySizeChange();
    }

    private applyExpanded(expanded: boolean): void {
        if (this.expanded === expanded) {
            return;
        }
        this.expanded = expanded;
        queueMicrotask(() => this.expandedChange.emit(expanded));
    }

    private persistBodyLayout(): void {
        if (!this.persistLayout || !this.layoutId || !this.panelBodyHeightPx) {
            return;
        }
        const width = this.currentBodyWidthPx();
        this.stateService.setPanelLayout(this.layoutId, {
            panelSize: {
                width,
                height: Math.round(this.panelBodyHeightPx)
            },
            panelExpanded: this.expanded
        });
    }

    private currentBodyWidthPx(): number {
        const contentWidth = this.contentRef?.nativeElement.getBoundingClientRect().width;
        if (Number.isFinite(contentWidth) && contentWidth! > 0) {
            return Math.round(contentWidth!);
        }
        const containerWidth = this.containerRef?.nativeElement.getBoundingClientRect().width;
        if (Number.isFinite(containerWidth) && containerWidth! > 0) {
            return Math.round(containerWidth!);
        }
        return Math.round(30 * this.stateService.baseFontSize);
    }

    private preferredBodyHeightPx(): number | undefined {
        const preferred = typeof this.preferredBodyHeightEm === 'function'
            ? this.preferredBodyHeightEm()
            : this.preferredBodyHeightEm;
        if (!Number.isFinite(preferred) || preferred! <= 0) {
            return undefined;
        }
        return preferred! * this.stateService.baseFontSize;
    }

    private measuredContentHeightPx(): number | undefined {
        const content = this.contentRef?.nativeElement;
        if (!content) {
            return undefined;
        }
        const height = content.scrollHeight;
        return Number.isFinite(height) && height > 0 ? height : undefined;
    }

    private defaultBodyHeightPx(): number {
        return this.clampBodyHeightPx(this.defaultBodyHeightEm * this.stateService.baseFontSize);
    }

    private seedBodyHeightPx(expanded = this.expanded): number {
        const defaultHeight = this.defaultBodyHeightPx();
        if (!expanded) {
            return defaultHeight;
        }
        const preferredHeight = this.preferredBodyHeightPx() ?? this.measuredContentHeightPx() ?? defaultHeight;
        return this.clampBodyHeightPx(Math.max(defaultHeight, preferredHeight));
    }

    private minBodyHeightPx(): number {
        return Math.max(1, this.minBodyHeightEm * this.stateService.baseFontSize);
    }

    private maxBodyHeightPx(): number {
        if (Number.isFinite(this.maxBodyHeightEm) && this.maxBodyHeightEm! > 0) {
            return Math.max(this.minBodyHeightPx(), this.maxBodyHeightEm! * this.stateService.baseFontSize);
        }
        const viewportLimit = window.innerHeight - this.stateService.baseFontSize * 6;
        return Math.max(this.minBodyHeightPx(), viewportLimit);
    }

    private clampBodyHeightPx(heightPx: number): number {
        return Math.min(this.maxBodyHeightPx(), Math.max(this.minBodyHeightPx(), heightPx));
    }

    private scheduleBodySizeChange(): void {
        if (!this.viewInitialized) {
            return;
        }
        window.requestAnimationFrame(() => this.bodySizeChange.emit());
    }
}
