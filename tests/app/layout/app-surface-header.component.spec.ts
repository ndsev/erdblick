import '@angular/compiler';
import {TestBed} from '@angular/core/testing';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AppSurfaceHeaderComponent} from '../../../app/layout/app-surface-header.component';

describe('editable surface title', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('publishes accepted titles once, cancels Escape, and keeps title gestures out of dragging', () => {
        const fixture = TestBed.createComponent(AppSurfaceHeaderComponent);
        fixture.componentRef.setInput('title', 'Original');
        fixture.componentRef.setInput('editableTitle', true);
        fixture.componentRef.setInput('dragEnabled', true);
        fixture.detectChanges();
        const changed = vi.fn();
        const dragged = vi.fn();
        fixture.componentInstance.title.subscribe(changed);
        fixture.componentInstance.dragPointerDown.subscribe(dragged);
        const button = fixture.nativeElement.querySelector('[data-testid="surface-title-edit"]') as HTMLButtonElement;
        button.dispatchEvent(new MouseEvent('pointerdown', {bubbles: true}));
        button.click();
        fixture.detectChanges();
        let input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
        input.value = 'Canceled';
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        fixture.detectChanges();
        expect(fixture.componentInstance.title()).toBe('Original');
        expect(changed).not.toHaveBeenCalled();
        expect(dragged).not.toHaveBeenCalled();

        button.click();
        fixture.detectChanges();
        input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
        input.value = ' Renamed ';
        input.dispatchEvent(new Event('input'));
        expect(fixture.componentInstance.title()).toBe('Original');
        const propagated = vi.fn();
        fixture.nativeElement.addEventListener('keydown', propagated);
        input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', isComposing: true, bubbles: true}));
        input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', isComposing: true, bubbles: true}));
        expect(fixture.componentInstance.title()).toBe('Original');
        expect(propagated).not.toHaveBeenCalled();
        input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
        input.dispatchEvent(new Event('blur'));
        fixture.detectChanges();
        expect(fixture.componentInstance.title()).toBe('Renamed');
        expect(changed).toHaveBeenCalledExactlyOnceWith('Renamed');
        fixture.destroy();
    });

    it('is opt-in and retires a draft when an external title replaces it', () => {
        const fixture = TestBed.createComponent(AppSurfaceHeaderComponent);
        fixture.componentRef.setInput('title', 'Original');
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('[data-testid="surface-title-edit"]')).toBeNull();
        fixture.componentRef.setInput('editableTitle', true);
        fixture.detectChanges();
        fixture.nativeElement.querySelector('button').click();
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('input')).not.toBeNull();
        fixture.componentRef.setInput('title', 'New source');
        fixture.componentRef.setInput('titleEditDisabled', true);
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('input')).toBeNull();
        expect(fixture.nativeElement.querySelector('[data-testid="surface-title-edit"]').disabled).toBe(true);
        expect(fixture.componentInstance.title()).toBe('New source');
        fixture.destroy();
    });
});
