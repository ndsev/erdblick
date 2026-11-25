import {Injectable, OnDestroy} from '@angular/core';
import {Subject, Subscription} from 'rxjs';
import {coreLib} from '../integrations/wasm.adapter';
import {MapViewService, ViewRecalculationReason} from '../mapview/mapview.service';
import {MapViewState} from '../mapview/mapview.state';
import {DrawingDocumentsService} from './drawing-documents.service';
import {VirtualSourceService} from './virtual-source.service';
import {DrawingState} from './drawing.state';
import {EMPTY_DRAWING} from './drawing.model';

export type DrawingTool = 'distance' | 'area' | 'angle' | 'pen' | 'point' | 'polygon' | 'ellipse';

/** One tool owns map clicks at a time, bound to a stable view identity. */
@Injectable({providedIn: 'root'})
export class DrawingToolsService implements OnDestroy {
    readonly changed = new Subject<void>();
    visible = false;
    active = false;
    clearing = false;
    viewId = '';
    points: [number, number][] = [];
    cursor?: [number, number];
    totalMeters = 0;
    tailMeters = 0;
    private readonly errors = {input: '', document: '', preview: ''};
    get error(): string { return this.errors.document || this.errors.preview || this.errors.input; }
    mode: DrawingTool = 'distance';
    color = '#ff8a24';
    shift = false;
    areaSquareMeters = 0;
    angleDegrees = 0;
    perimeterMeters = 0;
    private rawCursor?: [number, number];
    private dragging = false;
    private committedId?: string;
    private previewId?: string;
    private queue = Promise.resolve();
    private previewQueue = Promise.resolve();
    private committedPending?: {text: string; generation: number};
    private previewPending?: {text: string; generation: number};
    private committedFlushing = false;
    private previewFlushing = false;
    private committedText = '';
    private previewText = '';
    private generation = 0;
    private closing?: Promise<void>;
    private clearingTask?: Promise<void>;
    private frame?: number;
    private readonly subscriptions = new Subscription();

    /** Install semantic input hooks without coupling Deck to an Angular document owner. */
    constructor(public readonly state: DrawingState, private readonly sources: VirtualSourceService,
                private readonly docs: DrawingDocumentsService, private readonly views: MapViewService,
                private readonly viewState: MapViewState) {
        views.drawingInput = {
            click: (viewId, point, shift) => this.click(viewId, point, shift),
            move: (viewId, point, shift) => this.move(viewId, point, shift),
            down: (viewId, point, shift) => this.down(viewId, point, shift),
            up: (viewId, point) => this.up(viewId, point),
            cancel: () => { this.dragging = false; this.finish(); },
            leave: viewId => { if (viewId === this.viewId) this.move(viewId, undefined); }
        };
        this.subscriptions.add(viewState.viewIdsState.subscribe(ids => {
            if (this.viewId && !ids.includes(this.viewId)) void this.close();
            const previewView = this.viewId;
            if (this.previewId && ids.includes(previewView) && sources.sources.has(this.previewId)) this.restrictView(this.previewId, previewView);
        }));
        this.subscriptions.add(sources.recovered.subscribe(id => {
            if (id === this.previewId) this.restrictView(id, this.viewId);
        }));
        this.subscriptions.add(views.viewStateChanged.subscribe(reason => {
            if (reason !== ViewRecalculationReason.Viewport) return;
            if (this.active && this.points.length) { this.publishCommitted(); this.publishPreview(); }
        }));
        this.subscriptions.add(state.unit.subscribe(() => {
            if (this.points.length) { this.publishCommitted(); this.publishPreview(); }
            this.changed.next();
        }));
    }

    /** Fixed-point tools must be undone or restarted before accepting another position. */
    get canResume(): boolean {
        return (this.mode !== 'angle' || this.points.length < 3) && (this.mode !== 'ellipse' || this.points.length < 2);
    }

    /** Open the palette and resume incomplete input in its captured view. */
    start(): void {
        if (this.clearing) return;
        this.visible = true; this.active = this.canResume;
        if (!this.viewId) this.viewId = this.viewState.viewIdAt(this.viewState.focusedView);
        this.errors.input = ''; this.changed.next();
    }

    /** A tool switch retains the previous result and starts a separate local document. */
    async select(mode: DrawingTool): Promise<void> {
        if (this.clearing) return;
        if (mode === this.mode && this.active) return;
        await this.close(); this.mode = mode; this.start();
    }
    /** Start another result of the selected kind without removing the previous source. */
    async newDrawing(): Promise<void> { await this.close(); this.start(); }
    /** Style is stored with generated GeoJSON so exported drawings retain the chosen color. */
    setColor(color: string): void {
        if (!/^#[0-9a-f]{6}$/i.test(color)) return;
        this.color = color; this.publishCommitted(); this.publishPreview(); this.changed.next();
    }
    /** Reproject a stationary cursor immediately when the Shift key changes. */
    setShift(shift: boolean): void { this.shift = shift; this.move(this.viewId, this.rawCursor, shift); this.changed.next(); }
    /** Losing window focus clears snapping and finishes only an in-flight pen stroke. */
    blur(): void { this.setShift(false); if (this.dragging) this.finish(); }
    private snapped(point: [number, number]): [number, number] {
        const origin = this.points.at(-1);
        return this.shift && origin ? JSON.parse(coreLib.drawingSnap(...origin, ...point)) : point;
    }
    /** Freehand strokes capture the pointer while ordinary tools leave map navigation available. */
    private down(viewId: string, point: [number, number], shift = false): boolean {
        if (!this.active || this.clearing || this.viewId !== viewId || this.mode !== 'pen') return false;
        this.shift = shift; this.dragging = true; this.appendPoint(this.snapped(point)); return true;
    }
    private up(viewId: string, point?: [number, number]): void {
        if (!this.dragging || viewId !== this.viewId) return;
        if (point) this.appendPoint(this.snapped(point));
        this.dragging = false; this.finish();
    }

    /** Consume tool clicks before feature inspection, while preserving unrelated view input. */
    private click(viewId: string, point: [number, number], shift = false): boolean {
        if (!this.active || this.viewId !== viewId) return false;
        if (this.clearing || this.mode === 'pen') return true;
        this.shift = shift;
        this.appendPoint(this.snapped(point));
        if ((this.mode === 'angle' && this.points.length === 3) || (this.mode === 'ellipse' && this.points.length === 2)) this.finish();
        return true;
    }

    private appendPoint(point: [number, number]): void {
        if (this.points.length >= 10000) { this.errors.input = 'Drawing is limited to 10,000 positions.'; this.changed.next(); return; }
        const previous = this.points.at(-1);
        if (previous && this.distance(previous, point) < 0.001) return;
        if (previous) this.totalMeters += this.distance(previous, point);
        this.points.push(point); this.cursor = point;
        this.recalculate(); this.publishCommitted(); this.publishPreview(); this.changed.next();
    }

    /** Coalesce pointer work and keep the preview independent of the document worker. */
    private move(viewId: string, point?: [number, number], shift = this.shift): void {
        if (!this.active || this.viewId !== viewId) return;
        this.shift = shift; this.rawCursor = point;
        this.cursor = point ? this.snapped(point) : undefined;
        if (this.frame === undefined) this.frame = requestAnimationFrame(() => {
            this.frame = undefined;
            if (this.dragging && this.cursor) {
                const previous = this.points.at(-1);
                const index = this.viewState.viewIds.indexOf(this.viewId);
                const threshold = index < 0 ? 1 : this.viewState.getCameraPosition(index).height / Math.max(1, window.innerHeight) * 2;
                if (!previous || this.distance(previous, this.cursor) >= threshold) this.appendPoint(this.cursor);
            }
            this.recalculate(); this.publishPreview(); this.changed.next();
        });
    }
    /** Length is incremental; native geodesics supply polygon area and the vertex angle. */
    private recalculate(): void {
        this.tailMeters = this.cursor && this.points.length ? this.distance(this.points.at(-1)!, this.cursor) : 0;
        const points = this.active && this.cursor && this.tailMeters > 0 ? [...this.points, this.cursor] : this.points;
        if (this.mode === 'area' || this.mode === 'angle') {
            const metrics = JSON.parse(coreLib.drawingMetrics(JSON.stringify(points)));
            this.areaSquareMeters = metrics.areaSquareMeters; this.perimeterMeters = metrics.perimeterMeters;
            this.angleDegrees = metrics.angleDegrees;
        }
    }

    /** ESC ends input and removes the cursor tail without committing it. */
    finish(): void {
        this.active = false; this.dragging = false; this.cursor = undefined; this.rawCursor = undefined; this.tailMeters = 0;
        this.recalculate(); this.publishPreview(); this.changed.next();
    }
    /** Backspace repeatedly removes the last committed position, including the final one. */
    backspace(): void {
        if (this.clearing) return;
        this.errors.input = '';
        const last = this.points.pop(), previous = this.points.at(-1);
        if (last && previous) this.totalMeters = Math.max(0, this.totalMeters - this.distance(previous, last));
        else this.totalMeters = 0;
        if (this.rawCursor) this.cursor = this.snapped(this.rawCursor);
        this.recalculate();
        this.publishCommitted(); this.publishPreview(); this.changed.next();
    }
    /** Clear committed geometry through the same persistent GeoJSON document. */
    clear(): Promise<void> {
        if (this.closing) return this.closing;
        return this.clearingTask ??= this.clearMeasurement().finally(() => { this.clearingTask = undefined; });
    }
    private async clearMeasurement(): Promise<void> {
        this.dragging = false;
        this.clearing = true;
        ++this.generation;
        this.committedPending = undefined; this.previewPending = undefined;
        await Promise.all([this.queue, this.previewQueue]);
        this.points = []; this.cursor = undefined; this.rawCursor = undefined; this.totalMeters = 0; this.tailMeters = 0;
        this.areaSquareMeters = 0; this.angleDegrees = 0; this.perimeterMeters = 0;
        const doc = this.committedId ? this.docs.documents.get(this.committedId) : undefined;
        this.errors.input = '';
        if (doc) await this.docs.edit(doc, {type: 'tool', mapId: doc.mapId, text: this.renderSource([]), preview: false}, true)
            .then(() => { this.errors.document = ''; }).catch(error => this.fail(error));
        if (this.previewId) await this.sources.remove(this.previewId)
            .then(() => { this.errors.preview = ''; }).catch(error => this.fail(error, 'preview'));
        this.previewId = undefined; this.committedText = ''; this.previewText = '';
        this.clearing = false; this.changed.next();
    }
    /** Closing retains the local result and releases only cursor/input ownership. */
    close(): Promise<void> {
        return this.closing ??= this.closeMeasurement().finally(() => { this.closing = undefined; });
    }
    private async closeMeasurement(): Promise<void> {
        this.finish(); this.visible = false;
        await this.clearingTask;
        this.clearing = true;
        await Promise.all([this.queue, this.previewQueue]);
        ++this.generation;
        const doc = this.committedId ? this.docs.documents.get(this.committedId) : undefined;
        if (doc) doc.stopInput = undefined;
        if (this.previewId) await this.sources.remove(this.previewId).catch(error => this.fail(error, 'preview'));
        this.committedId = undefined; this.previewId = undefined;
        this.committedPending = undefined; this.previewPending = undefined;
        this.committedText = ''; this.previewText = '';
        this.points = []; this.cursor = undefined; this.rawCursor = undefined; this.totalMeters = 0; this.tailMeters = 0;
        this.areaSquareMeters = 0; this.angleDegrees = 0; this.perimeterMeters = 0;
        this.viewId = ''; this.clearing = false; this.errors.input = ''; this.errors.document = ''; this.errors.preview = ''; this.changed.next();
    }
    /** Protect a click waiting for its first document or latest native geometry during page exit. */
    get pendingUpdates(): boolean { return this.committedFlushing || !!this.committedPending || !!this.clearingTask; }

    /** Display unit changes never modify geometry or accumulated meter values. */
    format(meters: number): string {
        return (this.state.unit.value === 'miles' ? meters / 1609.344 : meters).toLocaleString(undefined,
            {maximumFractionDigits: this.state.unit.value === 'miles' ? 4 : 2}) + (this.state.unit.value === 'miles' ? ' mi' : ' m');
    }
    /** Area follows the configured distance unit squared. */
    formatArea(area: number): string {
        const miles = this.state.unit.value === 'miles';
        return (area / (miles ? 1609.344 ** 2 : 1)).toLocaleString(undefined, {maximumFractionDigits: miles ? 4 : 2}) + (miles ? ' mi²' : ' m²');
    }
    /** Accurate inverse geodesic shared with the native measurement path sampler. */
    private distance(a: [number, number], b: [number, number]): number { return coreLib.drawingDistance(a[0], a[1], b[0], b[1]); }
    /** Refine geodesic samples with zoom and polar Mercator scale, under a native vertex cap. */
    private renderSource(points: [number, number][], preview = false): string {
        const index = this.viewState.viewIds.indexOf(this.viewId);
        const altitude = index < 0 ? 200000 : this.viewState.getCameraPosition(index).height;
        const latitude = points.reduce((max, point) => Math.max(max, Math.abs(point[1])), 0);
        const cosine = Math.cos(Math.min(85.0511287, latitude) * Math.PI / 180);
        const pixelMeters = altitude / Math.max(1, window.innerHeight);
        // Quantized density avoids resampling history on pans and insignificant zoom changes.
        const idealLength = Math.sqrt(8 * 6378137 * pixelMeters * 0.25) * cosine;
        const maxSegmentLength = Math.max(100, Math.min(20000, 2 ** Math.floor(Math.log2(Math.max(1, idealLength)))));
        return JSON.stringify({points, maxSegmentLength, mode: this.mode, color: this.color, unit: this.state.unit.value,
            previousMeters: preview ? this.totalMeters : 0,
            previewLabel: preview && this.mode === 'area' ? this.formatArea(this.areaSquareMeters) :
                preview && this.mode === 'angle' ? this.angleDegrees.toFixed(2) + '°' : undefined});
    }

    /** Serialize click/history mutations, skipping superseded generations after Clear. */
    private publishCommitted(): void {
        if (this.clearing || (!this.points.length && !this.committedId && !this.committedFlushing)) return;
        const text = this.renderSource(this.points), generation = this.generation;
        if (text === this.committedText) return;
        this.committedText = text; this.committedPending = {text, generation};
        if (this.committedFlushing) return;
        this.committedFlushing = true;
        this.queue = this.flushCommitted().catch(error => { this.committedText = ''; this.fail(error); })
            .finally(() => { this.committedFlushing = false; });
    }

    /** Keep only the newest queued click/camera revision while a native history rebuild is running. */
    private async flushCommitted(): Promise<void> {
        while (this.committedPending) {
            const {text, generation} = this.committedPending; this.committedPending = undefined;
            if (generation !== this.generation) continue;
            try {
                if (!this.committedId) {
                    const doc = await this.docs.create('geojson', this.mode === 'distance' ? 'Measurement.geojson' : this.mode[0].toUpperCase() + this.mode.slice(1) + '.geojson', EMPTY_DRAWING, false,
                        {openEditor: false, stopInput: () => this.close()});
                    this.committedId = doc.mapId; doc.viewId = this.viewId; this.restrictView(doc.mapId);
                }
                const doc = this.docs.documents.get(this.committedId);
                if (!doc) throw new Error('Measurement document was removed.');
                await this.docs.edit(doc, {type: 'tool', mapId: doc.mapId, text, preview: false}, true);
                if (this.errors.document) { this.errors.document = ''; this.changed.next(); }
            } catch (error) {
                if (!this.committedPending) this.committedText = '';
                this.fail(error);
            }
        }
    }
    /** The preview lane uses a separate native owner in the UI heap, with at most two positions. */
    private publishPreview(): void {
        if (this.clearing) return;
        const point = this.active && this.cursor && this.points.at(-1) ? this.cursor : undefined;
        if (!point && !this.previewId && !this.previewFlushing) return;
        const text = this.renderSource(point ? [this.points.at(-1)!, point] : [], true), generation = this.generation;
        if (text === this.previewText) return;
        this.previewText = text; this.previewPending = {text, generation};
        if (this.previewFlushing) return;
        this.previewFlushing = true;
        this.previewQueue = this.flushPreview().catch(error => { this.previewText = ''; this.fail(error, 'preview'); })
            .finally(() => { this.previewFlushing = false; });
    }

    /** Bound cursor work to one executing and one newest pending revision. */
    private async flushPreview(): Promise<void> {
        while (this.previewPending) {
            const {text, generation} = this.previewPending; this.previewPending = undefined;
            if (generation !== this.generation) continue;
            try {
                if (!this.previewId) {
                    const id = 'drawing-' + crypto.randomUUID();
                    await this.sources.create(id, EMPTY_DRAWING, 'Measurement preview', true);
                    this.previewId = id;
                }
                await this.sources.change({type: 'tool', mapId: this.previewId, text, preview: true});
                this.restrictView(this.previewId, this.viewId);
                if (this.errors.preview) { this.errors.preview = ''; this.changed.next(); }
            } catch (error) {
                if (!this.previewPending) this.previewText = '';
                this.fail(error, 'preview');
            }
        }
    }
    /** New measurements and live previews begin in their captured view. */
    private restrictView(mapId: string, targetView = this.viewId): void {
        this.viewState.viewIds.forEach((id, index) => this.views.setMapLayerVisibility(index, mapId, 'Drawing', id === targetView));
    }
    /** Report native/worker failures in the widget without dropping the editable point history. */
    private fail(error: unknown, lane: 'document' | 'preview' = 'document'): void {
        this.errors[lane] = error instanceof Error ? error.message : String(error); this.changed.next();
    }
    /** Release callbacks and pending animation work with the application. */
    ngOnDestroy(): void {
        this.views.drawingInput = undefined; this.subscriptions.unsubscribe();
        if (this.frame !== undefined) cancelAnimationFrame(this.frame);
        this.changed.complete();
    }
}
