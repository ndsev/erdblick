import {Component, ViewChild} from '@angular/core';
import {AppStateService} from '../shared/appstate.service';
import {Dialog} from 'primeng/dialog';
import {DialogStackService} from '../shared/dialog-stack.service';

@Component({
    selector: 'keyboard-dialog',
    template: `
        <p-dialog header="Keyboard Controls" [(visible)]="stateService.controlsDialogVisible" [position]="'center'"
                  [resizable]="false" [modal]="false" [draggable]="true" class="pref-dialog"
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
                        <div class="control-desc">Zoom to Target Feature</div>
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
                        <div class="control-desc">Open inspection and pin it immediately</div>
                    </li>
                </ul>
            </div>
            <p-button (click)="close()" label="Close" icon="pi pi-times"></p-button>
        </p-dialog>
    `,
    styles: [
        `
            .keyboard-dialog {
                width: 25em;
                text-align: center;
                background-color: var(--p-content-background);
            }

            .keyboard-list {
                list-style-type: none;
                padding: 0;
            }

            .keyboard-list li {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 1em;
            }

            .keyboard-list li span {
                display: inline-block;
                background-color: var(--p-highlight-background);
                padding: 0.5em 0.75em;
                border-radius: 0.5em;
                color: var(--p-content-color);
                font-weight: bold;
                min-width: 4em;
                text-align: center;
            }

            .control-desc {
                color: var(--p-surface-500);
                font-size: 0.9em;
            }

            .key {
                border-radius: 0.5em;
                background-color: #ffcc00;
                font-size: 1em;
                padding: 0.5em 0.75em;
                color: #333;
            }

            .key-multi {
                display: flex;
                gap: 0.25em;
            }

            .key-multi .key {
                background-color: #00bcd4;
                padding: 0.3em 0.6em;
            }

            .highlight {
                background-color: #ff5722;
                color: white;
            }
        `
    ],
    standalone: false
})
export class KeyboardComponent {
    @ViewChild('keyboardDialog') keyboardDialog?: Dialog;

    constructor(public stateService: AppStateService,
                private dialogStack: DialogStackService) {}

    onDialogShow() {
        this.dialogStack.bringToFront(this.keyboardDialog);
    }

    close() {
        this.stateService.controlsDialogVisible = false;
    }
}
