import {Component, EventEmitter, Input, Output, ViewChild} from '@angular/core';
import {NgClass} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {ButtonModule} from 'primeng/button';
import {ColorPickerModule} from 'primeng/colorpicker';
import {TooltipModule} from 'primeng/tooltip';
import {Menu} from 'primeng/menu';
import {MenuModule} from 'primeng/menu';
import type {MenuItem, MenuItemCommandEvent, OverlayOptions} from 'primeng/api';

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
                @if (hasColorPicker || focusable) {
                    <span class="inspection-focus-indicator"
                          [class.inspection-focus-indicator-active]="focusable && focused">
                        @if (hasColorPicker) {
                            <p-colorpicker [ngModel]="color"
                                           [appendTo]="colorPickerAppendTo"
                                           [overlayOptions]="colorPickerOverlayOptions"
                                           (click)="$event.stopPropagation()"
                                           (mousedown)="$event.stopPropagation()"
                                           (ngModelChange)="updateColor($event)">
                            </p-colorpicker>
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
                            tooltipPosition="bottom"
                            (click)="handleTitleClick($event)"
                            (mousedown)="$event.stopPropagation()">
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
    imports: [ButtonModule, ColorPickerModule, FormsModule, MenuModule, NgClass, TooltipModule]
})
/** Generic header used by docked panels and floating dialogs. */
export class AppSurfaceHeaderComponent {
    @Input() title = '';
    @Input() titleTooltip = '';
    @Input() titleIcon = '';
    @Input() lockable = false;
    @Input() locked = false;
    @Input() featureTitle = false;
    @Input() hasColorPicker = false;
    @Input() color = '';
    @Input() colorPickerAppendTo: 'body' | HTMLElement | undefined = 'body';
    @Input() colorPickerOverlayOptions: OverlayOptions = {autoZIndex: true, baseZIndex: 9500};
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

    @Output() colorChange = new EventEmitter<string>();
    @Output() focusRequest = new EventEmitter<Event>();
    @Output() dragPointerDown = new EventEmitter<PointerEvent>();
    @Output() titleClick = new EventEmitter<MouseEvent>();
    @Output() dockRequest = new EventEmitter<MouseEvent>();
    @Output() sizeToggleRequest = new EventEmitter<MouseEvent>();
    @Output() closeRequest = new EventEmitter<MouseEvent>();

    @ViewChild('extraActionsMenu') private extraActionsMenu?: Menu;
    private extraActionsMenuAnchor?: HTMLElement;

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
        if (!this.dragEnabled || event.button !== 0 || this.isInteractiveTarget(event.target as HTMLElement | null)) {
            return;
        }
        this.dragPointerDown.emit(event);
    }

    protected updateColor(color: string): void {
        this.color = color;
        this.colorChange.emit(color);
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
        event.stopPropagation();
        this.titleClick.emit(event);
    }

    private isInteractiveTarget(target: HTMLElement | null): boolean {
        if (!target) {
            return false;
        }
        return !!target.closest(
            'button, .p-button, .p-colorpicker, .p-select, .p-dropdown, .p-multiselect, input, textarea, select, option, a'
        );
    }
}
