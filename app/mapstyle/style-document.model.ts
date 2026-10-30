import {Document, isAlias, isMap, isNode, isScalar, isSeq, parseDocument} from "yaml";

export type StylePath = readonly (string | number)[];
export type StyleDocumentEdit =
    | {op: "set"; path: StylePath; value: unknown; remove?: readonly string[]}
    | {op: "remove"; path: StylePath}
    | {op: "rename"; path: StylePath; key: string}
    | {op: "append"; path: StylePath; value: unknown}
    | {op: "duplicate"; path: StylePath; index: number}
    | {op: "move"; path: StylePath; index: number; to: number};

/** Source-backed style edits. No projection into search defaults or renderer semantics. */
export class StyleDocumentModel {
    private readonly document: Document;

    /** Parses syntax only so native-invalid fields remain available for correction in the GUI. */
    constructor(readonly source: string) {
        this.document = parseDocument(source, {keepSourceTokens: true, intAsBigInt: true});
        if (this.document.errors.length) throw new Error(this.document.errors.map(error => error.message).join("\n"));
        if (!isMap(this.document.contents)) throw new Error("A stylesheet must be a YAML mapping.");
    }

    /** Reads a field without materializing defaults, dropping numeric precision or mutating aliases. */
    value(path: StylePath): unknown {
        const node = this.node(path);
        if (isScalar(node)) return node.value;
        if (isNode(node)) return node.toJS(this.document);
        return undefined;
    }

    /** Reports actual presence, including explicit false, zero, empty strings and null. */
    has(path: StylePath): boolean { return this.node(path) !== undefined; }

    /** Returns authored mapping keys for unknown-field notices. */
    keys(path: StylePath): string[] {
        const node = this.node(path);
        return isMap(node) ? node.items.map(pair => String(isScalar(pair.key) ? pair.key.value : pair.key)) : [];
    }

    /** Returns the list length without converting its items. */
    length(path: StylePath): number {
        const node = this.node(path);
        return isSeq(node) ? node.items.length : 0;
    }

    /** Determines a record's shape without treating an alias as an unsupported field. */
    isRecord(path: StylePath): boolean { return isMap(this.node(path)); }
    isList(path: StylePath): boolean { return isSeq(this.node(path)); }

    /** Applies a single intentional edit to a fresh AST, retaining unrelated nodes and comments. */
    edit(edit: StyleDocumentEdit): string {
        const next = new StyleDocumentModel(this.source);
        next.makePathLocal(edit.path);
        const doc = next.document;
        if (edit.op === "set") {
            const old = doc.getIn(edit.path, true);
            if (isScalar(old) && (typeof old.value === typeof edit.value)) {
                old.value = edit.value;
            } else {
                const replacement = doc.createNode(edit.value);
                if (isNode(old)) {
                    replacement.comment = old.comment;
                    replacement.commentBefore = old.commentBefore;
                    replacement.spaceBefore = old.spaceBefore;
                    if ((isScalar(old) || isMap(old) || isSeq(old))
                        && (isScalar(replacement) || isMap(replacement) || isSeq(replacement))) {
                        replacement.anchor = old.anchor;
                    }
                }
                doc.setIn(edit.path, replacement);
            }
            for (const key of edit.remove ?? []) doc.deleteIn([...edit.path.slice(0, -1), key]);
        } else if (edit.op === "rename") {
            const parent = doc.getIn(edit.path.slice(0, -1), true);
            if (!isMap(parent)) throw new Error("The field no longer belongs to a record.");
            const pair = parent.items.find(item => isScalar(item.key) && item.key.value === edit.path.at(-1));
            if (!pair) throw new Error("The field no longer exists.");
            if (parent.has(edit.key)) throw new Error("Unset the conflicting field before changing branch kind.");
            pair.key = doc.createNode(edit.key);
        } else if (edit.op === "remove") {
            doc.deleteIn(edit.path);
        } else {
            const list = doc.getIn(edit.path, true);
            if (!isSeq(list)) throw new Error("This field must be a list before editing its items.");
            if (edit.op === "append") list.add(doc.createNode(edit.value));
            else {
                if (edit.index < 0 || edit.index >= list.items.length) throw new Error("The item no longer exists.");
                if (edit.op === "duplicate") {
                    list.items.splice(edit.index + 1, 0, next.localCopy(list.items[edit.index], new Set()));
                } else {
                    if (edit.to < 0 || edit.to >= list.items.length) throw new Error("The destination no longer exists.");
                    list.items.splice(edit.to, 0, ...list.items.splice(edit.index, 1));
                }
            }
        }
        return doc.toString({lineWidth: 120});
    }

    /** Resolves aliases only while following the requested path, with cycle detection. */
    private node(path: StylePath): unknown {
        let current: unknown = this.document.contents;
        const seen = new Set<unknown>();
        for (let i = 0; i <= path.length; ++i) {
            while (isAlias(current)) {
                if (seen.has(current)) throw new Error("Cyclic aliases cannot be edited as a form.");
                seen.add(current);
                current = current.resolve(this.document);
            }
            if (i === path.length) return current;
            current = isMap(current) || isSeq(current) ? current.get(path[i], true) : undefined;
        }
        return undefined;
    }

    /** Editing an alias creates a local copy, leaving its source and other uses unchanged. */
    private makePathLocal(path: StylePath): void {
        for (let i = 1; i <= path.length; ++i) {
            const prefix = path.slice(0, i);
            const node = this.document.getIn(prefix, true);
            if (isAlias(node)) this.document.setIn(prefix, this.localCopy(node, new Set()));
        }
    }

    /** Copies an alias/duplicate subtree without duplicate anchors or shared mutable nodes. */
    private localCopy(value: unknown, ancestors: Set<unknown>): unknown {
        if (!isNode(value)) return value;
        if (ancestors.has(value)) throw new Error("Cyclic aliases cannot be copied into a style rule.");
        const seen = new Set(ancestors).add(value);
        if (isAlias(value)) return this.localCopy(value.resolve(this.document), seen);
        const copy = value.clone();
        if (isScalar(copy) || isMap(copy) || isSeq(copy)) copy.anchor = undefined;
        if (isMap(copy)) {
            copy.items = copy.items.map(pair => {
                pair.value = this.localCopy(pair.value, seen);
                return pair;
            });
        } else if (isSeq(copy)) copy.items = copy.items.map(item => this.localCopy(item, seen));
        return copy;
    }
}

/** Parses a typed numeric form input, retaining integers beyond JavaScript's safe range. */
export function parseStyleNumber(text: string): number | bigint {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) {
        throw new Error("Enter a finite number.");
    }
    if (/^[+-]?\d+$/.test(text.trim())) {
        const integer = BigInt(text.trim());
        if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) return integer;
    }
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error("Enter a finite number.");
    return value;
}
