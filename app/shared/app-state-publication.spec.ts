import '@angular/compiler';
import {describe, expect, it} from 'vitest';
import {Subject} from 'rxjs';
import {Router} from '@angular/router';
import {z} from 'zod';
import {AppStateService} from './appstate.service';
import {InfoMessageService} from './info.service';

/** Provides registration and publication without starting browser navigation. */
function setup() {
    const registry = new AppStateService({events: new Subject()} as unknown as Router, {} as InfoMessageService);
    const left = registry.registerState({name: 'left', defaultValue: 0, schema: z.number()});
    const right = registry.registerState({name: 'right', defaultValue: 0, schema: z.number()});
    return {registry, left, right};
}

describe('AppState publication', () => {
    it('rolls back a failed edit without publishing slot or completed-state events', () => {
        const {registry, left, right} = setup();
        const values: number[] = [];
        left.subscribe(value => values.push(value));
        const observations: number[][] = [];
        registry.observe(() => [left.value, right.value]).subscribe(value => observations.push(value));
        expect(() => registry.transaction(() => {
            left.next(1);
            right.next(2);
            throw new Error('invalid prepared operation');
        })).toThrow('invalid prepared operation');
        expect([left.value, left.getValue(), right.value]).toEqual([0, 0, 0]);
        expect(values).toEqual([0]);
        expect(observations).toEqual([[0, 0]]);
        left.subscribe(value => expect(value).toBe(0)).unsubscribe();
    });

    it('stages every value before slot notifications and publishes one completed projection', () => {
        const {registry, left, right} = setup();
        const slotObservations: number[][] = [];
        left.subscribe(value => slotObservations.push([value, right.getValue()]));
        const complete: number[][] = [];
        registry.observe(() => [left.value, right.value]).subscribe(value => complete.push(value));
        registry.transaction(() => {
            left.next(1);
            right.next(2);
            expect(left.value).toBe(left.getValue());
        });
        expect(slotObservations).toEqual([[0, 0], [1, 2]]);
        expect(complete).toEqual([[0, 0], [1, 2]]);
    });

    it('queues writes from a completed-state observer until every observer sees the same commit', () => {
        const {registry, left} = setup();
        const first: number[] = [], second: number[] = [];
        registry.observe(() => left.value).subscribe(value => {
            first.push(value);
            if (value === 1) left.next(2);
        });
        registry.observe(() => left.value).subscribe(value => second.push(value));
        left.next(1);
        expect(first).toEqual([0, 1, 2]);
        expect(second).toEqual([0, 1, 2]);
    });
});
