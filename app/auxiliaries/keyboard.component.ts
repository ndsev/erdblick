import {Component, ViewChild} from '@angular/core';
import {AppStateService, KEYBOARD_DIALOG_LAYOUT_ID} from '../shared/appstate.service';
import {DialogStackService} from '../shared/dialog-stack.service';
import {AppDialogComponent} from '../shared/app-dialog.component';

@Component({
    selector: 'keyboard-dialog',
    template: `
        <app-dialog header="Keyboard Controls" [(visible)]="dialogVisible" [position]="'center'"
                  [resizable]="false" [modal]="false" [draggable]="true" class="pref-dialog"
                  [persistLayout]="true" [layoutId]="dialogLayoutId"
                  #keyboardDialog (onShow)="onDialogShow()">
            <div class="keyboard-dialog">
                <ul class="keyboard-list">
                    <li>
                        <div class="key-multi">
                            <span class="key highlight">Ctrl</span>
                            <span class="key">K</span>
                        </div>
                        <div class="control-desc">Open Search</div>
                    </li>
                    <li>
                        <div class="key-multi">
                            <span class="key highlight">Ctrl</span>
                            <span class="key">J</span>
                        </div>
                        <div class="control-desc">Zoom to Focused Inspection</div>
                    </li>
                    <li>
                        <span class="key">M</span>
                        <div class="control-desc">Open Maps & Styles Panel</div>
                    </li>
                    <li>
                        <span class="key">W</span>
                        <div class="control-desc">Move Camera Up</div>
                    </li>
                    <li>
                        <span class="key">A</span>
                        <div class="control-desc">Move Camera Left</div>
                    </li>
                    <li>
                        <span class="key">S</span>
                        <div class="control-desc">Move Camera Down</div>
                    </li>
                    <li>
                        <span class="key">D</span>
                        <div class="control-desc">Move Camera Right</div>
                    </li>
                    <li>
                        <span class="key">Q</span>
                        <div class="control-desc">Zoom In</div>
                    </li>
                    <li>
                        <span class="key">E</span>
                        <div class="control-desc">Zoom Out</div>
                    </li>
                    <li>
                        <span class="key">R</span>
                        <div class="control-desc">Reset Camera Orientation</div>
                    </li>
                    <li>
                        <div class="key-multi">
                            <span class="key highlight">Ctrl</span>
                            <span class="key">X</span>
                        </div>
                        <div class="control-desc">Open Viewport Statistics</div>
                    </li>
                    <li>
                        <div class="key-multi">
                            <span class="key highlight">Ctrl</span>
                            <span class="key">Left <-</span>
                        </div>
                        <div class="control-desc">Cycle through Viewers to the left</div>
                    </li>
                    <li>
                        <div class="key-multi">
                            <span class="key highlight">Ctrl</span>
                            <span class="key">Right -></span>
                        </div>
                        <div class="control-desc">Cycle through Viewers to the right</div>
                    </li>
                    <li>
                        <div class="key-multi">
                            <span class="key highlight">Ctrl</span>
                            <span class="key">Left Click</span>
                        </div>
                        <div class="control-desc">Open inspection and lock it immediately</div>
                    </li>
                </ul>
            </div>
            <p-button (click)="close()" label="Close" icon="pi pi-times"></p-button>
        </app-dialog>
    `,
    standalone: false
})
/** Static keyboard shortcut reference dialog. */
export class KeyboardComponent {
    readonly dialogLayoutId = KEYBOARD_DIALOG_LAYOUT_ID;

    @ViewChild('keyboardDialog') keyboardDialog?: AppDialogComponent;

    constructor(public stateService: AppStateService,
                private dialogStack: DialogStackService) {}

    get dialogVisible(): boolean {
        return this.stateService.isDialogOpen(this.dialogLayoutId);
    }

    set dialogVisible(visible: boolean) {
        this.stateService.setDialogOpen(this.dialogLayoutId, visible);
    }

    /** Promotes the keyboard-help dialog above other overlays. */
    onDialogShow() {
        this.dialogStack.bringToFront(this.keyboardDialog);
    }

    /** Closes the keyboard-help dialog. */
    close() {
        this.dialogVisible = false;
    }
}
