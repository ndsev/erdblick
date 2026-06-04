import {Component, EventEmitter, Input, OnDestroy, Output, ViewChild} from '@angular/core';
import {NgClass} from '@angular/common';
import {ButtonModule} from 'primeng/button';
import {TooltipModule} from 'primeng/tooltip';
import {Menu} from 'primeng/menu';
import {MenuModule} from 'primeng/menu';
import type {MenuItem, MenuItemCommandEvent} from 'primeng/api';
import type {ButtonSeverity} from 'primeng/types/button';

export type AppSurfaceHeaderDockMode = 'none' | 'dock' | 'undock';

export interface AppSurfaceHeaderActionCommandEvent {
    originalEvent: MouseEvent;
    anchor: HTMLElement;
    source: 'inline' | 'menu';
}

export interface AppSurfaceHeaderAction {
    label: string;
    tooltip?: string;
    icon?: string;
    menuIcon?: string;
    materialIcon?: string;
    severity?: ButtonSeverity;
    outlined?: boolean;
    styleClass?: string;
    disabled?: boolean;
    command: (event: AppSurfaceHeaderActionCommandEvent) => void;
}

@Component({
    selector: 'app-surface-header',
    template: `
        <div class="app-surface-header inspector-title"
             [ngClass]="{'app-surface-header-focused': focused, 'app-surface-header-drag': dragEnabled}"
             (pointerdown)="onPointerDown($event)"
             (focusin)="focusRequest.emit($event)">
            <span class="app-surface-header-title-group title-container"
                  [class.feature]="featureTitle">
                @if (hasSmartControl || focusable) {
                    <span class="inspection-focus-indicator"
                          [class.inspection-focus-indicator-active]="focusable && focused">
                        @if (hasSmartControl) {
                            <ng-content select="[surfaceHeaderSmartControl]"></ng-content>
                        } @else {
                            <ng-content select="[surfaceHeaderIndicator]"></ng-content>
                        }
                    </span>
                } @else {
                    <ng-content select="[surfaceHeaderIndicator]"></ng-content>
                }
                @if (lockable) {
                    <button type="button"
                            class="app-surface-header-title title"
                            [pTooltip]="titleTooltip || (locked ? 'Unlock ' + title : 'Lock ' + title)"
                            [tooltipDisabled]="titleTooltipDisabled"
                            tooltipPosition="bottom"
                            (click)="handleTitleClick($event)"
                            (mousedown)="handleTitleMouseDown($event)">
                        <span class="material-symbols-outlined">
                            @if (locked) {
                                lock
                            } @else {
                                lock_open_right
                            }
                        </span>
                        <span class="app-surface-header-title-text title-span">{{ title }}</span>
                    </button>
                } @else {
                    <div class="app-surface-header-title title"
                         [pTooltip]="titleTooltip || title"
                         [tooltipDisabled]="titleTooltipDisabled"
                         tooltipPosition="bottom">
                        @if (titleIcon) {
                            <span class="material-symbols-outlined">{{ titleIcon }}</span>
                        }
                        <span class="app-surface-header-title-text title-span">{{ title }}</span>
                    </div>
                }
                <ng-content select="[surfaceHeaderAfterTitle]"></ng-content>
            </span>
            <span class="app-surface-header-actions">
                <ng-content select="[surfaceHeaderActions]"></ng-content>
                @if (extraActions.length > 0) {
                    <span class="app-surface-header-actions-extra">
                        @for (action of extraActions; track action.label) {
                            <p-button [icon]="action.materialIcon ? '' : (action.icon ?? '')"
                                      [disabled]="action.disabled"
                                      [severity]="action.severity"
                                      [outlined]="action.outlined"
                                      [styleClass]="action.styleClass"
                                      [pTooltip]="action.tooltip || action.label"
                                      tooltipPosition="bottom"
                                      (click)="emitExtraAction(action, $event, 'inline')"
                                      (mousedown)="$event.stopPropagation()">
                                @if (action.materialIcon) {
                                    <span class="material-symbols-outlined app-surface-header-button-icon">
                                        {{ action.materialIcon }}
                                    </span>
                                }
                            </p-button>
                        }
                    </span>
                    <p-button class="app-surface-header-actions-menu"
                              icon=""
                              pTooltip="More actions"
                              tooltipPosition="bottom"
                              (click)="openExtraActionsMenu($event)"
                              (mousedown)="$event.stopPropagation()">
                        <span class="material-symbols-outlined app-surface-header-button-icon">more_vert</span>
                    </p-button>
                    <p-menu #extraActionsMenu
                            [popup]="true"
                            [model]="extraActionsMenuItems"
                            appendTo="body"
                            [baseZIndex]="30000"
                            [style]="{'font-size': '0.9em'}"/>
                }
                @if (dockMode !== 'none') {
                    <p-button icon=""
                              [disabled]="dockDisabled"
                              [pTooltip]="dockTooltip"
                              tooltipPosition="bottom"
                              (click)="emitDockRequest($event)"
                              (mousedown)="$event.stopPropagation()">
                        <span class="material-symbols-outlined app-surface-header-button-icon">
                            @if (dockMode === 'dock') {
                                move_to_inbox
                            } @else {
                                eject
                            }
                        </span>
                    </p-button>
                }
                @if (sizeToggleVisible) {
                    <p-button icon=""
                              [disabled]="sizeToggleDisabled"
                              [pTooltip]="expanded ? 'Shrink to default height' : 'Expand to fit content'"
                              [tooltipPosition]="sizeTooltipPosition"
                              (click)="emitSizeToggleRequest($event)"
                              (mousedown)="$event.stopPropagation()">
                        <span class="material-symbols-outlined app-surface-header-button-icon">
                            @if (expanded) {
                                unfold_less
                            } @else {
                                unfold_more
                            }
                        </span>
                    </p-button>
                }
                @if (closeVisible) {
                    <p-button icon="pi pi-times"
                              severity="secondary"
                              [disabled]="closeDisabled"
                              [pTooltip]="closeTooltip"
                              tooltipPosition="bottom"
                              (click)="emitCloseRequest($event)"
                              (mousedown)="$event.stopPropagation()"/>
                }
            </span>
        </div>
    `,
    standalone: true,
    imports: [ButtonModule, MenuModule, NgClass, TooltipModule]
})
/** Generic header used by docked panels and floating dialogs. */
export class AppSurfaceHeaderComponent implements OnDestroy {
    private static readonly titleDragClickThresholdPx = 4;

    @Input() title = '';
    @Input() titleTooltip = '';
    @Input() titleTooltipDisabled = false;
    @Input() titleIcon = '';
    @Input() lockable = false;
    @Input() locked = false;
    @Input() featureTitle = false;
    @Input() hasSmartControl = false;
    @Input() focusable = false;
    @Input() focused = false;
    @Input() dragEnabled = false;
    @Input() dockMode: AppSurfaceHeaderDockMode = 'none';
    @Input() dockDisabled = false;
    @Input() sizeToggleVisible = false;
    @Input() sizeToggleDisabled = false;
    @Input() sizeTooltipPosition: 'left' | 'right' | 'top' | 'bottom' = 'left';
    @Input() expanded = false;
    @Input() closeVisible = true;
    @Input() closeDisabled = false;
    @Input() closeTooltip = 'Close';
    @Input() extraActions: AppSurfaceHeaderAction[] = [];

    @Output() focusRequest = new EventEmitter<Event>();
    @Output() dragPointerDown = new EventEmitter<PointerEvent>();
    @Output() titleClick = new EventEmitter<MouseEvent>();
    @Output() dockRequest = new EventEmitter<MouseEvent>();
    @Output() sizeToggleRequest = new EventEmitter<MouseEvent>();
    @Output() closeRequest = new EventEmitter<MouseEvent>();

    @ViewChild('extraActionsMenu') private extraActionsMenu?: Menu;
    private extraActionsMenuAnchor?: HTMLElement;
    private titleDragMoveListener?: (event: PointerEvent) => void;
    private titleDragEndListener?: (event: PointerEvent) => void;
    private suppressNextTitleClick = false;

    protected get dockTooltip(): string {
        return this.dockMode === 'dock' ? 'Dock' : 'Undock';
    }

    protected get extraActionsMenuItems(): MenuItem[] {
        return this.extraActions.map(action => ({
            label: action.label,
            icon: action.menuIcon ?? action.icon,
            disabled: action.disabled,
            command: (event: MenuItemCommandEvent) => this.emitExtraMenuAction(action, event)
        }));
    }

    protected onPointerDown(event: PointerEvent): void {
        this.focusRequest.emit(event);
        const target = event.target as HTMLElement | null;
        if (this.dragEnabled && event.button === 0 && target?.closest('.app-surface-header-title')) {
            this.trackTitleDragClickSuppression(event);
            this.dragPointerDown.emit(event);
            return;
        }
        if (!this.dragEnabled || event.button !== 0 || this.isInteractiveTarget(target)) {
            return;
        }
        this.dragPointerDown.emit(event);
    }

    protected openExtraActionsMenu(event: MouseEvent): void {
        event.stopPropagation();
        this.extraActionsMenuAnchor = (event.currentTarget || event.target) as HTMLElement;
        this.extraActionsMenu?.toggle(event);
    }

    protected emitExtraAction(action: AppSurfaceHeaderAction, event: MouseEvent, source: 'inline' | 'menu'): void {
        event.stopPropagation();
        if (action.disabled) {
            return;
        }
        action.command({
            originalEvent: event,
            anchor: source === 'menu'
                ? (this.extraActionsMenuAnchor ?? ((event.currentTarget || event.target) as HTMLElement))
                : ((event.currentTarget || event.target) as HTMLElement),
            source
        });
    }

    private emitExtraMenuAction(action: AppSurfaceHeaderAction, event: MenuItemCommandEvent): void {
        const originalEvent = event.originalEvent && event.originalEvent instanceof MouseEvent
            ? event.originalEvent
            : new MouseEvent('click');
        this.emitExtraAction(action, originalEvent, 'menu');
    }

    protected emitDockRequest(event: MouseEvent): void {
        event.stopPropagation();
        if (this.dockDisabled) {
            return;
        }
        this.dockRequest.emit(event);
    }

    protected emitSizeToggleRequest(event: MouseEvent): void {
        event.stopPropagation();
        if (this.sizeToggleDisabled) {
            return;
        }
        this.sizeToggleRequest.emit(event);
    }

    protected emitCloseRequest(event: MouseEvent): void {
        event.stopPropagation();
        if (this.closeDisabled) {
            return;
        }
        this.closeRequest.emit(event);
    }

    protected handleTitleClick(event: MouseEvent): void {
        if (this.suppressNextTitleClick) {
            this.suppressNextTitleClick = false;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        event.stopPropagation();
        this.titleClick.emit(event);
    }

    protected handleTitleMouseDown(event: MouseEvent): void {
        if (!this.dragEnabled) {
            event.stopPropagation();
        }
    }

    private isInteractiveTarget(target: HTMLElement | null): boolean {
        if (!target) {
            return false;
        }
        if (target.closest('.app-surface-header-title')) {
            return false;
        }
        return !!target.closest(
            'button, .p-button, .p-colorpicker, .p-select, p-select, .p-dropdown, .p-multiselect, p-multiselect, .p-treeselect, p-treeselect, .p-toggleswitch, p-toggleswitch, p-iftalabel, input, textarea, select, option, a'
        );
    }

    /** Removes global drag tracking listeners if the header is destroyed mid-drag. */
    ngOnDestroy(): void {
        this.clearTitleDragTracking();
    }

    /** Detects title-bar drags so the click generated after mouseup does not toggle the lock state. */
    private trackTitleDragClickSuppression(event: PointerEvent): void {
        this.clearTitleDragTracking();
        this.suppressNextTitleClick = false;
        const startX = event.clientX;
        const startY = event.clientY;
        const pointerId = event.pointerId;
        const thresholdSquared =
            AppSurfaceHeaderComponent.titleDragClickThresholdPx *
            AppSurfaceHeaderComponent.titleDragClickThresholdPx;

        this.titleDragMoveListener = moveEvent => {
            if (moveEvent.pointerId !== pointerId) {
                return;
            }
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            if (dx * dx + dy * dy >= thresholdSquared) {
                this.suppressNextTitleClick = true;
            }
        };
        this.titleDragEndListener = endEvent => {
            if (endEvent.pointerId === pointerId) {
                this.clearTitleDragTracking();
            }
        };
        window.addEventListener('pointermove', this.titleDragMoveListener, true);
        window.addEventListener('pointerup', this.titleDragEndListener, true);
        window.addEventListener('pointercancel', this.titleDragEndListener, true);
    }

    /** Stops observing pointer movement while preserving the pending click-suppression flag. */
    private clearTitleDragTracking(): void {
        if (this.titleDragMoveListener) {
            window.removeEventListener('pointermove', this.titleDragMoveListener, true);
            this.titleDragMoveListener = undefined;
        }
        if (this.titleDragEndListener) {
            window.removeEventListener('pointerup', this.titleDragEndListener, true);
            window.removeEventListener('pointercancel', this.titleDragEndListener, true);
            this.titleDragEndListener = undefined;
        }
    }
}
