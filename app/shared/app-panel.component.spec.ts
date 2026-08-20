import '@angular/compiler';
import {ElementRef} from '@angular/core';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {AppPanelComponent} from './app-panel.component';
import {AppStateService} from './appstate.service';

interface AppPanelTestAccess {
    contentRef?: ElementRef<HTMLElement>;
    containerRef?: ElementRef<HTMLElement>;
    panelBodyHeightPx?: number;
    beginContentResize(event: PointerEvent): void;
    continueContentResize(event: PointerEvent): void;
    finishContentResize(event: PointerEvent): void;
}

function pointerEvent(
    handle: HTMLElement,
    pointerId: number,
    clientY: number,
    button = 0
): PointerEvent {
    return {
        button,
        pointerId,
        clientY,
        currentTarget: handle,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn()
    } as unknown as PointerEvent;
}

function rect(width: number, height: number): DOMRect {
    return {
        x: 0,
        y: 0,
        top: 0,
        right: width,
        bottom: height,
        left: 0,
        width,
        height,
        toJSON: () => ({})
    };
}

describe('AppPanelComponent custom resizing', () => {
    const setPanelLayout = vi.fn();
    let component: AppPanelComponent;
    let internals: AppPanelTestAccess;
    let handle: HTMLElement;
    let capturedPointer: number | undefined;

    beforeEach(() => {
        const stateService = {
            baseFontSize: 16,
            setPanelLayout
        } as unknown as AppStateService;
        component = new AppPanelComponent(stateService);
        component.layoutId = 'test-panel';
        component.persistLayout = true;
        component.resizeMode = 'vertical';
        component.dockedPanelCount = 2;
        component.minBodyHeightEm = 10;
        component.maxBodyHeightEm = 30;

        const content = document.createElement('div');
        vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(rect(480, 320));
        const container = document.createElement('div');
        vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(rect(520, 360));
        internals = component as unknown as AppPanelTestAccess;
        internals.contentRef = new ElementRef(content);
        internals.containerRef = new ElementRef(container);
        internals.panelBodyHeightPx = 320;

        handle = document.createElement('div');
        handle.style.cursor = 'row-resize';
        capturedPointer = undefined;
        Object.defineProperties(handle, {
            setPointerCapture: {
                value: vi.fn((pointerId: number) => capturedPointer = pointerId)
            },
            hasPointerCapture: {
                value: vi.fn((pointerId: number) => capturedPointer === pointerId)
            },
            releasePointerCapture: {
                value: vi.fn((pointerId: number) => {
                    if (capturedPointer === pointerId) {
                        capturedPointer = undefined;
                    }
                })
            }
        });
        document.body.style.cursor = 'crosshair';
        document.body.style.userSelect = 'text';
        setPanelLayout.mockClear();
    });

    afterEach(() => {
        component.ngOnDestroy();
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        vi.restoreAllMocks();
    });

    it('updates only the in-memory height while dragging and persists once on release', () => {
        internals.beginContentResize(pointerEvent(handle, 7, 100));
        expect(capturedPointer).toBe(7);
        expect(document.body.style.userSelect).toBe('none');

        internals.continueContentResize(pointerEvent(handle, 7, 160));
        expect(internals.panelBodyHeightPx).toBe(380);
        expect(setPanelLayout).not.toHaveBeenCalled();

        internals.finishContentResize(pointerEvent(handle, 7, 160));
        expect(setPanelLayout).toHaveBeenCalledTimes(1);
        expect(setPanelLayout).toHaveBeenCalledWith('test-panel', {
            panelSize: {width: 480, height: 380},
            panelExpanded: true
        });
        expect(capturedPointer).toBeUndefined();
        expect(document.body.style.cursor).toBe('crosshair');
        expect(document.body.style.userSelect).toBe('text');
    });

    it('clamps pointer movement to the existing panel height limits', () => {
        internals.beginContentResize(pointerEvent(handle, 11, 100));
        internals.continueContentResize(pointerEvent(handle, 11, 2000));
        expect(internals.panelBodyHeightPx).toBe(480);

        internals.continueContentResize(pointerEvent(handle, 11, -2000));
        expect(internals.panelBodyHeightPx).toBe(160);
        internals.finishContentResize(pointerEvent(handle, 11, -2000));
        expect(setPanelLayout).toHaveBeenCalledWith('test-panel', {
            panelSize: {width: 480, height: 160},
            panelExpanded: false
        });
    });

    it('restores pointer capture and body styles when destroyed mid-gesture', () => {
        internals.beginContentResize(pointerEvent(handle, 19, 100));
        component.ngOnDestroy();

        expect(capturedPointer).toBeUndefined();
        expect(document.body.style.cursor).toBe('crosshair');
        expect(document.body.style.userSelect).toBe('text');
        expect(setPanelLayout).not.toHaveBeenCalled();
    });
});
