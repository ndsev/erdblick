import {Injectable} from "@angular/core";
import {forkJoin, map, Observable, of} from "rxjs";
import {z} from "zod";
import {deepEquals} from "../shared/state-value";
import {rejectAction} from "./action-utils";
import {ControlDeclaration, ControlReadContext} from "./control";
import type {ControlReadResult, ControlTarget, ControlWriteResult, createControlActions} from "./control-actions";
import type {ActionSuggestion, SearchTarget} from "./omnibar";
import {ViewerActionFailure} from "./viewer-action-relay.contract";

/** Trusted, owner-local public contract; permission follows mutation in the exporter. */
export interface ActionDeclaration<Input extends z.ZodType = z.ZodType, Output extends z.ZodType = z.ZodType> {
    name: string;
    description: string;
    mutation: boolean;
    inputSchema: Input;
    outputSchema: Output;
}

export interface ActionContext {
    signal?: AbortSignal;
}

/**
 * Holds registered operations, not application state. Owners bind their typed methods
 * once during startup. The relay and omnibar share the same validation boundary.
 */
@Injectable({providedIn: "root"})
export class AppActionService {
    private readonly controls = new Map<
        string,
        {
            declaration: ControlDeclaration;
            read: (selector: unknown, context: ControlReadContext) => unknown;
            write?: (selector: unknown, value: unknown) => void;
            overview?: () => Record<string, unknown>[];
        }
    >();

    registerControl<Selector extends z.ZodObject, Value extends z.ZodType>(
        declaration: ControlDeclaration<Selector, Value>,
        binding: {
            read: (selector: z.output<Selector>, context: ControlReadContext) => z.input<Value>;
            write?: (selector: z.output<Selector>, value: z.output<Value>) => void;
            overview?: () => z.input<Selector>[];
        }
    ): void {
        if (this.controls.has(declaration.name)) throw new Error(`Duplicate control: ${declaration.name}`);
        if (declaration.writable !== !!binding.write)
            throw new Error(`Control write contract mismatch: ${declaration.name}`);
        this.controls.set(declaration.name, {
            declaration,
            read: (selector, context) => binding.read(declaration.selectorSchema.parse(selector), context),
            write: binding.write
                ? (selector, value) =>
                      binding.write!(declaration.selectorSchema.parse(selector), declaration.valueSchema.parse(value))
                : undefined,
            overview: binding.overview
        });
    }

    registerControlActions(declarations: ReturnType<typeof createControlActions>): void {
        this.registerAction(declarations.describeControls, (input) => {
            const controls = [];
            const omissions: {control: string; reason: "byte_limit" | "item_limit"}[] = [];
            let budget = 208 * 1024;
            for (const {declaration} of this.controls.values()) {
                if (input.controls && !input.controls.includes(declaration.name)) continue;
                if (input.prefix !== undefined && !declaration.name.startsWith(input.prefix)) continue;
                const metadata = {
                    ...declaration,
                    selectorSchema: z.toJSONSchema(declaration.selectorSchema, {
                        target: "draft-07",
                        io: "input",
                        reused: "inline"
                    }),
                    valueSchema: z.toJSONSchema(declaration.valueSchema, {
                        target: "draft-07",
                        io: "input",
                        reused: "inline"
                    })
                };
                const bytes = new TextEncoder().encode(JSON.stringify(metadata)).length;
                if (bytes > budget || controls.length === 64) {
                    omissions.push({control: declaration.name, reason: bytes > budget ? "byte_limit" : "item_limit"});
                } else {
                    budget -= bytes;
                    controls.push(metadata);
                }
            }
            return {observedAt: new Date().toISOString(), controls, complete: omissions.length === 0, omissions};
        });
        this.registerAction(declarations.getControls, (input) => this.readControls(input.targets));
        this.registerAction(declarations.setControl, (input) => this.writeControl(input.target, input.value));
    }

    readControls(requested?: ControlTarget[]): ControlReadResult {
        const result: ControlReadResult = {
            observedAt: new Date().toISOString(),
            values: [],
            complete: true,
            omissions: []
        };
        const targets =
            requested ??
            [...this.controls.values()].flatMap((binding) =>
                (binding.overview?.() ?? []).map((selector) => ({...selector, control: binding.declaration.name}))
            );
        if (targets.length > 32) {
            // One bounded omission describes the remaining default overview targets.
            result.omissions.push({target: targets[32], reason: "item_limit", omittedCount: targets.length - 32});
        }
        let budget = 208 * 1024;
        for (const target of targets.slice(0, 32)) {
            if (budget < 1024) {
                result.omissions.push({target, reason: "byte_limit"});
                continue;
            }
            const {control: name, ...selector} = target;
            const binding = this.controls.get(name);
            if (!binding) rejectAction("Unknown control", "invalid_arguments");
            const context = new ControlReadContext(budget - 512);
            let entry: ControlReadResult["values"][number];
            try {
                const value = binding.read(selector, context);
                const validated = binding.declaration.valueSchema.safeParse(value);
                entry = validated.success
                    ? {target, value: validated.data}
                    : {target, unavailable: "value_out_of_contract"};
            } catch (error) {
                if (!(error instanceof ViewerActionFailure) || error.detail.code !== "not_available") throw error;
                entry = {
                    target,
                    unavailable:
                        error.detail.reason === "first_person"
                            ? "first_person"
                            : error.detail.reason === "view_unavailable"
                              ? "view_unavailable"
                              : "target_unavailable"
                };
            }
            const bytes = new TextEncoder().encode(JSON.stringify(entry)).length;
            if (bytes > budget) {
                result.omissions.push({target, reason: "byte_limit"});
                continue;
            }
            budget -= bytes;
            result.values.push(entry);
            if (context.reason) result.omissions.push({target, reason: context.reason});
            if ("unavailable" in entry) result.complete = false;
        }
        result.complete &&= result.omissions.length === 0 && targets.length <= 32;
        return result;
    }

    writeControl(target: ControlTarget, value: unknown): ControlWriteResult {
        const {control: name, ...selector} = target;
        const binding = this.controls.get(name);
        if (!binding?.write) rejectAction("Control is not writable", "invalid_arguments");
        // Validate the whole incoming assignment before any owner operation runs.
        const validated = binding.declaration.valueSchema.parse(value);
        const before = binding.read(selector, new ControlReadContext());
        binding.write(selector, validated);
        const after = binding.declaration.valueSchema.parse(binding.read(selector, new ControlReadContext()));
        return {
            status: "applied",
            target,
            value: after,
            changed: !deepEquals(before, after),
            readiness: {status: "unknown"}
        };
    }

    assertControlsComplete(declarations: readonly ControlDeclaration[]): void {
        const names = new Set(declarations.map((control) => control.name));
        if (names.size !== declarations.length) throw new Error("Duplicate control in exported catalog");
        if (
            names.size !== this.controls.size ||
            declarations.some((control) => this.controls.get(control.name)?.declaration !== control)
        ) {
            throw new Error("Control owner registration differs from exported catalog");
        }
    }

    private readonly actions = new Map<
        string,
        {
            declaration: ActionDeclaration;
            execute: (input: unknown, context: ActionContext) => unknown;
        }
    >();

    registerAction<Input extends z.ZodType, Output extends z.ZodType>(
        declaration: ActionDeclaration<Input, Output>,
        execute: (input: z.output<Input>, context: ActionContext) => z.input<Output> | Promise<z.input<Output>>,
        omnibar?: {suggest: (query: string) => ActionSuggestion<z.input<Input>>[]}
    ): void {
        if (this.actions.has(declaration.name)) throw new Error(`Duplicate action: ${declaration.name}`);
        this.actions.set(declaration.name, {
            declaration,
            execute: (input, context) => {
                if (context.signal?.aborted) rejectAction("Action cancelled", "cancelled");
                const parsed = declaration.inputSchema.safeParse(input);
                if (!parsed.success) rejectAction("Arguments do not match the action schema", "invalid_arguments");
                const result = execute(parsed.data, context);
                return result instanceof Promise
                    ? result.then((value) => declaration.outputSchema.parse(value))
                    : declaration.outputSchema.parse(result);
            }
        });
        if (omnibar)
            this.registerOmnibar(declaration.name, (query) =>
                omnibar.suggest(query).map((candidate) => ({
                    ...candidate,
                    saveToHistory: () => false,
                    validate: (input) => candidate.isCurrent() && candidate.validate(input),
                    execute: async () => {
                        // A menu may stay open while its target is removed or replaced.
                        if (!candidate.isCurrent())
                            rejectAction("The suggested target is no longer available", "not_available");
                        await this.execute(declaration.name, candidate.arguments);
                    }
                }))
            );
    }

    private readonly omnibar = new Map<string, {order: number; targets: (query: string) => SearchTarget[]}>();
    private readonly asyncOmnibar = new Map<string, (query: string) => Observable<SearchTarget[]>>();

    registerOmnibar(name: string, targets: (query: string) => SearchTarget[], order = 0): () => void {
        if (this.omnibar.has(name)) throw new Error(`Duplicate omnibar producer: ${name}`);
        const registration = {order, targets};
        this.omnibar.set(name, registration);
        return () => {
            if (this.omnibar.get(name) === registration) this.omnibar.delete(name);
        };
    }

    registerAsyncOmnibar(name: string, targets: (query: string) => Observable<SearchTarget[]>): () => void {
        if (this.asyncOmnibar.has(name)) throw new Error(`Duplicate omnibar producer: ${name}`);
        this.asyncOmnibar.set(name, targets);
        return () => {
            if (this.asyncOmnibar.get(name) === targets) this.asyncOmnibar.delete(name);
        };
    }

    omnibarTargets(query: string): SearchTarget[] {
        return [...this.omnibar.values()]
            .sort((a, b) => a.order - b.order)
            .flatMap((provider) => provider.targets(query));
    }

    /** Unsubscribing cancels the providers' HTTP work; the panel owns debounce and stale-query display. */
    asyncOmnibarTargets(query: string): Observable<SearchTarget[]> {
        const requests = [...this.asyncOmnibar.values()].map((provider) => provider(query));
        return requests.length ? forkJoin(requests).pipe(map((results) => results.flat())) : of([]);
    }

    execute(name: string, input: unknown, context: ActionContext = {}): unknown {
        const action = this.actions.get(name);
        if (!action) throw new Error(`Action owner was not registered: ${name}`);
        return action.execute(input, context);
    }

    has(name: string): boolean {
        return this.actions.has(name);
    }

    /** Fail startup on missing/extra bindings instead of advertising unusable tools. */
    assertComplete(declarations: readonly ActionDeclaration[]): void {
        const expected = new Set(declarations.map((action) => action.name));
        if (expected.size !== declarations.length) throw new Error("Duplicate action in exported catalog");
        const mismatched = declarations
            .filter((action) => this.actions.get(action.name)?.declaration !== action)
            .map((action) => action.name);
        const missing = [...expected].filter((name) => !this.actions.has(name));
        const extra = [...this.actions.keys()].filter((name) => !expected.has(name));
        if (missing.length || extra.length || mismatched.length) {
            throw new Error(`Action registration mismatch: missing ${missing}; extra ${extra}; contract ${mismatched}`);
        }
    }
}
