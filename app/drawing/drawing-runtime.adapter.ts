import type {DrawingSource} from "../../build/libs/core/erdblick-core";
import {coreLib, uint8ArrayFromWasm} from "../integrations/wasm.adapter";
import type {DrawingOperation, DrawingReply, DrawingSummary} from "./drawing.model";

/** One WASM heap's document owners; shared by the worker and bounded live-preview lane. */
export class DrawingRuntime {
    private readonly sources = new Map<string, {native: DrawingSource; revision: number; bom: boolean}>();

    /** Execute an ordered operation; native import failure retains the previous accepted model. */
    execute(operation: DrawingOperation): DrawingReply {
        if (operation.type === "convert-coordinates") return {text: coreLib.drawingCoordinatesToGeoJson(operation.text)};
        const mapId = operation.mapId;
        if (operation.type === "remove") {
            this.sources.get(mapId)?.native.delete();
            this.sources.delete(mapId);
            return {};
        }
        if (operation.type === "create") {
            if (this.sources.has(mapId)) throw new Error("Drawing source already exists.");
            const native: DrawingSource = new coreLib.DrawingSource(mapId);
            try {
                const summary: DrawingSummary = JSON.parse(operation.checkpoint
                    ? native.restore(operation.text, operation.checkpoint) : native.replace(operation.text));
                this.sources.set(mapId, {native, revision: summary.revision, bom: operation.text.startsWith('\ufeff')});
                return {
                    summary, text: operation.text, checkpoint: native.checkpoint(),
                    schema: uint8ArrayFromWasm(out => native.schema(out))!,
                    dictionary: uint8ArrayFromWasm(out => native.dictionary(out))!
                };
            } catch (error) {
                native.delete();
                throw error;
            }
        }
        const entry = this.sources.get(mapId);
        if (!entry) throw new Error("This local document is no longer available.");
        const native = entry.native;
        if (operation.type === "rows") return {rows: JSON.parse(native.rows(operation.offset, operation.count)), revision: entry.revision};
        if (operation.type === "filter" || operation.type === "snapshot") {
            const bytes = uint8ArrayFromWasm(out => operation.type === "filter"
                ? native.filter(JSON.stringify(operation.request), out)
                : native.snapshot(JSON.stringify(operation.ids), out));
            if (!bytes) throw new Error("Could not serialize the local model.");
            return {bytes, dictionary: uint8ArrayFromWasm(out => native.dictionary(out))!, revision: entry.revision};
        }
        const serialized = operation.type === "tool" ? native.replace(coreLib.drawingToolGeoJson(operation.text, operation.preview)) :
            operation.type === "replace" ? native.replace(operation.text) :
            operation.type === "description" ? native.editDescription(operation.id, operation.description) :
            operation.type === "append" ? native.append(operation.longitude, operation.latitude, operation.description) :
            native.join(JSON.stringify(operation.ids));
        const summary: DrawingSummary = JSON.parse(serialized);
        entry.revision = summary.revision;
        if (operation.type === 'replace') entry.bom = operation.text.startsWith('\ufeff');
        let text = operation.type === 'replace' ? operation.text : native.source();
        // Embind's UTF-8 decoder consumes a leading BOM. Structured native edits preserve it,
        // so restore that known source prefix at the JS string boundary, without reformatting text.
        if (entry.bom && !text.startsWith('\ufeff')) text = '\ufeff' + text;
        return {summary, text, checkpoint: native.checkpoint(),
            dictionary: uint8ArrayFromWasm(out => native.dictionary(out))!};
    }

    /** Release every native wrapper before retiring this worker or preview lane. */
    destroy(): void {
        for (const entry of this.sources.values()) entry.native.delete();
        this.sources.clear();
    }
}
