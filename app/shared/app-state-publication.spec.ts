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

describe('publication rollback and reactive edits', () => {
    it('does not publish a net-no-op and preserves touched object identity', () => {
        const {registry, left, right} = setup();
        const object = registry.registerState({name: 'object', defaultValue: {items: [1]}, schema: z.unknown()});
        const original = object.value;
        const slots: unknown[] = [];
        const commits: unknown[] = [];
        object.subscribe(value => slots.push(value));
        registry.observe(() => [left.value, right.value, object.value]).subscribe(value => commits.push(value));
        registry.transaction(() => {
            left.next(1);
            object.next({items: [2]});
            registry.transaction(() => {right.next(4); right.next(0);});
            left.next(0);
            object.next({items: [1]});
        });
        expect(object.value).toBe(original);
        expect(slots).toEqual([original]);
        expect(commits).toEqual([[0, 0, original]]);
    });

    it('keeps a previously staged outer change when a nested transaction is a no-op', () => {
        const {registry, left} = setup();
        const observed: number[] = [];
        left.subscribe(value => observed.push(value));
        registry.transaction(() => {
            left.next(1);
            registry.transaction(() => {left.next(2); left.next(1);});
        });
        expect(observed).toEqual([0, 1]);
    });

    it('preserves untouched object identity and restores touched objects after failure', () => {
        const {registry, left} = setup();
        const unrelated = registry.registerState({name: 'unrelated', defaultValue: {large: [1, 2, 3]}, schema: z.unknown()});
        const touched = registry.registerState({name: 'touched', defaultValue: {items: ['original']}, schema: z.unknown()});
        const oldUnrelated = unrelated.value, oldTouched = touched.value;
        expect(() => registry.transaction(() => { touched.next({items: ['changed']}); left.next(1); throw new Error('rollback'); })).toThrow();
        expect(unrelated.value).toBe(oldUnrelated);
        expect(touched.value).toBe(oldTouched);
        expect(oldTouched).toEqual({items: ['original']});
    });

    it('queues a complete owner transaction from a completed-state subscriber', () => {
        const {registry, left, right} = setup();
        const first: number[][] = [], second: number[][] = [];
        registry.observe(() => [left.value, right.value]).subscribe(value => {
            first.push(value);
            if (value[0] === 1) registry.transaction(() => {left.next(2); right.next(20);});
        });
        registry.observe(() => [left.value, right.value]).subscribe(value => second.push(value));
        registry.transaction(() => {left.next(1); right.next(10);});
        expect(first).toEqual([[0, 0], [1, 10], [2, 20]]);
        expect(second).toEqual(first);
    });

    it('keeps outer staged values after a caught nested rollback', () => {
        const {registry, left, right} = setup();
        registry.transaction(() => {
            left.next(1);
            expect(() => registry.transaction(() => {left.next(2); right.next(2); throw new Error('inner');})).toThrow();
            expect([left.value, right.value]).toEqual([1, 0]);
            right.next(3);
        });
        expect([left.value, right.value]).toEqual([1, 3]);
    });
});

describe('subscriptions during edits', () => {
    it('delays a new completed observer until success or rollback, while slot reads remain staged', () => {
        const {registry, left} = setup();
        const observed: number[] = [];
        expect(() => registry.transaction(() => {
            left.next(1);
            expect(left.value).toBe(1);
            left.subscribe(value => expect(value).toBe(1)).unsubscribe();
            registry.observe(() => left.value).subscribe(value => observed.push(value));
            expect(observed).toEqual([]);
            throw new Error('rollback');
        })).toThrow();
        expect(observed).toEqual([0]);
    });

    it('honors ordered writes from completed observers even when the later value matches the old commit', () => {
        const {registry, left} = setup();
        const values: number[] = [];
        let acted = false;
        registry.observe(() => left.value).subscribe(value => {
            if (value === 1 && !acted) {acted = true; left.next(2); left.next(1);}
        });
        registry.observe(() => left.value).subscribe(value => values.push(value));
        left.next(1);
        expect(left.value).toBe(1);
        expect(values).toEqual([0, 1]);
    });
});
