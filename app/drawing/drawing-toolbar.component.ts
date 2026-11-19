import {ChangeDetectorRef, Component, ElementRef, HostListener, OnDestroy, ViewChild} from '@angular/core';
import {Popover} from 'primeng/popover';
import {ColorPicker, ColorPickerChangeEvent} from 'primeng/colorpicker';
import {Subscription} from 'rxjs';
import {DrawingTool, DrawingToolsService} from './drawing-tools.service';

/** Compact map tools with a pointer-captured grip; position is a local UI preference. */
@Component({selector: 'drawing-toolbar', standalone: false, template: `
    @if (tools.visible) {
        <section #bar class="drawing-toolbar" data-testid="drawing-toolbar" aria-label="Draw and measure"
                 [class.positioned]="position" [style.left.px]="position?.left" [style.top.px]="position?.top">
            <div class="tool-strip" role="toolbar" aria-label="Drawing and measurement tools" (keydown)="navigate($event)">
                <button type="button" class="grip" aria-label="Move drawing toolbar" pTooltip="Drag to move · Arrow keys to move when focused"
                        data-testid="drawing-toolbar-grip" (pointerdown)="beginDrag($event)" (pointermove)="drag($event)"
                        (pointerup)="endDrag($event)" (pointercancel)="endDrag($event)" (lostpointercapture)="endDrag($event)"
                        (keydown)="moveWithKeyboard($event)"><span class="material-symbols-outlined" aria-hidden="true">drag_indicator</span></button>
                @for (group of toolGroups; track group.label) {
                    <div class="tool-group" role="group" [attr.aria-label]="group.label">
                        @for (item of group.tools; track item.id) {
                            <button type="button" [class.selected]="tools.mode === item.id" [disabled]="tools.clearing"
                                    [attr.aria-label]="item.title" [attr.aria-pressed]="tools.mode === item.id" [pTooltip]="item.title"
                                    [attr.data-testid]="'drawing-tool-' + item.id" (click)="tools.select(item.id)">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="item.path"/></svg>
                            </button>
                        }
                    </div>
                }
                <div class="tool-group" role="group" aria-label="Drawing actions">
                    <span class="color-control" pTooltip="Drawing color">
                        <p-colorpicker #colorPicker [ngModel]="tools.color" format="hex" appendTo="body"
                                       [overlayOptions]="{baseZIndex: 31000}"
                                       [pt]="{preview: {'aria-label': 'Drawing color', style: {width: '22px', height: '22px', padding: '0'}}}"
                                       [disabled]="tools.clearing" (onChange)="color($event)" (keydown.escape)="$event.stopPropagation()"/>
                    </span>
                    <button type="button" aria-label="New drawing" pTooltip="New drawing" [disabled]="tools.clearing" (click)="tools.newDrawing()"><i class="pi pi-plus" aria-hidden="true"></i></button>
                    <button type="button" aria-label="Undo point" pTooltip="Undo point (Backspace)" [disabled]="!tools.points.length || tools.clearing" (click)="tools.backspace()"><i class="pi pi-undo" aria-hidden="true"></i></button>
                    <button type="button" class="finish" [attr.aria-label]="tools.active ? 'Finish' : 'Resume'" [pTooltip]="tools.active ? 'Finish (Esc)' : 'Resume'"
                            [disabled]="tools.clearing || (!tools.active && !tools.canResume)" (click)="tools.active ? tools.finish() : tools.start()">
                        <i [class]="tools.active ? 'pi pi-check' : 'pi pi-play'" aria-hidden="true"></i>
                    </button>
                </div>
                <div class="tool-group">
                    <button type="button" aria-label="Drawing options" pTooltip="Units and tool help" (click)="options.toggle($event)" data-testid="drawing-options-toggle"><i class="pi pi-ellipsis-v" aria-hidden="true"></i></button>
                    <button type="button" aria-label="Close drawing toolbar" pTooltip="Close drawing toolbar" (click)="tools.close()" data-testid="drawing-toolbar-close"><i class="pi pi-times" aria-hidden="true"></i></button>
                </div>
            </div>
            <div class="measure-readout" data-testid="measurement-widget">
                <span class="mode-status" data-testid="drawing-status" role="status">{{selected.label}}{{tools.active ? '' : ' complete'}}</span>
                @if (tools.mode === 'area') {
                    <strong data-testid="measurement-area">{{tools.formatArea(tools.areaSquareMeters)}}</strong>
                    <span>Perimeter <strong data-testid="measurement-perimeter">{{tools.format(tools.perimeterMeters)}}</strong></span>
                } @else if (tools.mode === 'angle') {
                    <strong data-testid="measurement-angle">{{tools.angleDegrees.toFixed(2)}}°</strong>
                    <span>Last <strong data-testid="measurement-segment">{{tools.format(tools.tailMeters)}}</strong></span>
                } @else if (tools.mode === 'distance') {
                    <span>Last <strong data-testid="measurement-segment">{{tools.format(tools.tailMeters)}}</strong></span>
                    <span>Total <strong data-testid="measurement-total">{{tools.format(tools.totalMeters + tools.tailMeters)}}</strong></span>
                }
                <span class="position-count" data-testid="measurement-points">{{tools.points.length}} positions</span>
                @if (tools.active && tools.mode !== 'pen' && tools.mode !== 'point') {
                    <span class="snap-indicator" [class.enabled]="tools.shift" pTooltip="Hold Shift to snap to 45° increments">45°</span>
                }
            </div>
            @if (tools.error) { <p class="tool-error" role="alert">{{tools.error}}</p> }
            <p-popover #options appendTo="body">
                <div class="tool-options" data-testid="drawing-options" (keydown.escape)="$event.preventDefault(); $event.stopPropagation(); options.hide()">
                    <strong>{{selected.title}}</strong>
                    <p>{{tools.active ? selected.hint : 'Result kept as a local datasource. Start a new drawing to continue.'}}</p>
                    <label>Units <select aria-label="Unit" [ngModel]="tools.state.unit.value" (ngModelChange)="tools.state.unit.next($event)">
                        <option value="meters">Meters</option><option value="miles">Miles</option>
                    </select></label>
                    <p-button label="Clear drawing" ariaLabel="Clear" icon="pi pi-trash" size="small" severity="danger" [text]="true"
                              [disabled]="!tools.points.length || tools.clearing" (onClick)="tools.clear(); options.hide()"/>
                </div>
            </p-popover>
        </section>
    }
`, styleUrls: ['../scss/drawing-toolbar.component.scss']})
export class DrawingToolbarComponent implements OnDestroy {
    readonly modes: {id: DrawingTool; label: string; title: string; path: string; hint: string}[] = [
        {id: 'distance', label: 'Distance', title: 'Measure distance', path: 'M3 17 8 7 16 15 21 5 M3 17h.01M8 7h.01M16 15h.01M21 5h.01', hint: 'Click successive points. Hold Shift to snap. Backspace undoes; Esc finishes.'},
        {id: 'area', label: 'Area', title: 'Measure area', path: 'm4 6 13-3 4 14-13 4Z M8 9l7-2M9 13l7-2M10 17l7-2', hint: 'Click at least three corners. Area includes the cursor. Esc finishes the polygon.'},
        {id: 'angle', label: 'Angle', title: 'Measure angle', path: 'M21 19H4L17 5 M12 19a8 8 0 0 0-2.8-6', hint: 'Click the first arm, the vertex, then the second arm to measure the angle.'},
        {id: 'pen', label: 'Pen', title: 'Free drawing pen', path: 'M3 19c3-7 5 5 8-1 M12 12l6-8 3 3-7 7-4 1Z', hint: 'Press and drag on the map to draw a freehand stroke. Release to finish.'},
        {id: 'point', label: 'Point', title: 'Draw points', path: 'M12 21s7-7 7-12A7 7 0 0 0 5 9c0 5 7 12 7 12Z M15 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0', hint: 'Click to place points. Each point is stored in the same local GeoJSON document.'},
        {id: 'polygon', label: 'Polygon', title: 'Draw polygon', path: 'm4 7 8-4 8 6-3 12-13-4Z M4 7h.01M12 3h.01M20 9h.01M17 21h.01', hint: 'Click at least three corners. The shape closes automatically. Esc finishes.'},
        {id: 'ellipse', label: 'Ellipse', title: 'Draw ellipse', path: 'M21 12a9 6 0 1 1-18 0 9 6 0 0 1 18 0 M12 3v18M2 12h20', hint: 'Click the center, then a corner of its bounding box to set both radii.'}
    ];
    readonly toolGroups = [
        {label: 'Measurement tools', tools: this.modes.slice(0, 3)},
        {label: 'Drawing tools', tools: this.modes.slice(3)}
    ];
    position: {left: number; top: number} | null;
    private element?: HTMLElement;
    private observer?: ResizeObserver;
    private session?: {pointerId: number; x: number; y: number; left: number; top: number; handle: HTMLElement};
    private readonly subscription: Subscription;
    @ViewChild('options') private options?: Popover;
    @ViewChild('colorPicker') private colorPicker?: ColorPicker;

    /** Observe opening and content size changes, including narrow-window wrapping. */
    @ViewChild('bar') set bar(ref: ElementRef<HTMLElement> | undefined) {
        this.endDrag();
        this.observer?.disconnect();
        this.element = ref?.nativeElement;
        if (this.element) {
            this.observer = new ResizeObserver(() => this.keepInViewport());
            this.observer.observe(this.element);
        }
    }

    /** Subscribe to live tool changes without making the toolbar own the drawing session. */
    constructor(public readonly tools: DrawingToolsService, private readonly cdr: ChangeDetectorRef) {
        this.position = tools.state.toolbarPosition.value;
        this.subscription = tools.changed.subscribe(() => cdr.markForCheck());
    }
    get selected() { return this.modes.find(mode => mode.id === this.tools.mode)!; }

    /** Update the selected drawing's GeoJSON color through its tool owner. */
    color(event: ColorPickerChangeEvent): void {
        // Keep focus on the preview while dragging the spectrum; Escape belongs to the picker.
        event.originalEvent.preventDefault();
        if (typeof event.value === 'string') this.tools.setColor(event.value);
    }

    /** Capture the grip, so moving the toolbar never pans or draws on the map. */
    beginDrag(event: PointerEvent): void {
        if (event.button !== 0 || this.session || !this.element) return;
        event.preventDefault(); event.stopPropagation();
        this.options?.hide();
        this.colorPicker?.hide();
        const bounds = this.element.getBoundingClientRect();
        const handle = event.currentTarget as HTMLElement;
        this.session = {pointerId: event.pointerId, x: event.clientX, y: event.clientY,
            left: bounds.left, top: bounds.top, handle};
        handle.setPointerCapture(event.pointerId);
    }

    /** Apply pointer deltas to the initial bounds without accumulating rounding errors. */
    drag(event: PointerEvent): void {
        const session = this.session;
        if (!session || session.pointerId !== event.pointerId) return;
        this.place(session.left + event.clientX - session.x, session.top + event.clientY - session.y);
    }

    /** End capture on release, cancellation, loss of capture, close or destruction. */
    endDrag(event?: PointerEvent): void {
        const session = this.session;
        if (!session || (event && session.pointerId !== event.pointerId)) return;
        this.session = undefined;
        if (session.handle.hasPointerCapture(session.pointerId)) session.handle.releasePointerCapture(session.pointerId);
        if (this.position) this.tools.state.toolbarPosition.next(this.position);
    }

    /** Offer the same movement to keyboard users; Shift increases the step. */
    moveWithKeyboard(event: KeyboardEvent): void {
        if (!this.element || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        this.options?.hide();
        this.colorPicker?.hide();
        const bounds = this.element.getBoundingClientRect(), step = event.shiftKey ? 50 : 10;
        this.place(bounds.left + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
            bounds.top + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0));
        this.tools.state.toolbarPosition.next(this.position);
    }

    /** Arrow keys move between enabled tools while native inputs retain their own keys. */
    navigate(event: KeyboardEvent): void {
        if (!(event.target instanceof HTMLButtonElement) || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const controls = Array.from(this.element!.querySelectorAll<HTMLElement>('.tool-strip button:not(:disabled), .tool-strip input'));
        const index = controls.indexOf(event.target), delta = event.key === 'ArrowLeft' ? -1 : 1;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + delta + controls.length) % controls.length;
        event.preventDefault(); event.stopPropagation(); controls[next]?.focus();
    }

    /** Refit after viewport changes without overwriting the user's saved placement. */
    @HostListener('window:resize') keepInViewport(): void {
        if (!this.element) return;
        const bounds = this.element.getBoundingClientRect();
        this.place(bounds.left, bounds.top);
    }

    /** Keep the complete toolbar reachable, including its readout, at the window edges. */
    private place(left: number, top: number): void {
        if (!this.element) return;
        this.position = {
            left: Math.max(8, Math.min(left, window.innerWidth - this.element.offsetWidth - 8)),
            // Leave room for the map's bottom coordinate/status controls after a resize.
            top: Math.max(8, Math.min(top, window.innerHeight - this.element.offsetHeight - 56))
        };
        this.cdr.markForCheck();
    }

    /** Release pointer and observer lifetimes when the workspace is destroyed. */
    ngOnDestroy(): void {
        this.endDrag(); this.observer?.disconnect(); this.subscription.unsubscribe();
    }
}
