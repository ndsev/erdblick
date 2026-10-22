import {forkJoin, map, Observable, of} from "rxjs";
import {z} from "zod";
import {deepEquals} from "../shared/state-value";
import {Action, ActionContext, ActionDeclaration, ActionMetadata, action, getActionMetadata} from "./action";
import {rejectAction} from "./action-utils";
import {Control, ControlReadContext, isControl} from "./control";
import {ControlReadResult, ControlTarget, ControlWriteResult, createControlActions} from "./control-actions";
import {ActionSuggestion, OmnibarProvider, SearchTarget, getOmnibarProvider} from "./omnibar";
import {ViewerActionFailure} from "./viewer-action-relay.contract";

/**
 * One catalog of the operations contributed by the composed SignalStore.
 * It owns dispatch, bounded public projections and omnibar candidate collection;
 * it contains no application values and performs no service construction.
 * Adding an annotated method or control to a feature is sufficient for discovery.
 */
export class ActionCatalog {
    private readonly controls = new Map<string, Control>();
    private readonly actions = new Map<string, ActionMetadata>();
    private readonly providers: OmnibarProvider[] = [];
    /** The fixed public allowlist used by both browser transports and the build exporter. */
    readonly publicActions: Readonly<Record<string, ActionDeclaration>>;

    /**
     * Inspect the composed features once. Native signals are ordinary functions
     * without action metadata, so discovery never reads their application values.
     */
    constructor(store: object) {
        const suggestedActions: ActionMetadata[] = [];
        for (const key of Reflect.ownKeys(store)) {
            const member: unknown = Reflect.get(store, key);
            if (isControl(member)) {
                if (this.controls.has(member.declaration.name)) {
                    throw new Error(`Duplicate control: ${member.declaration.name}`);
                }
                this.controls.set(member.declaration.name, member);
            }
            const metadata = getActionMetadata(member);
            if (metadata) {
                this.addAction(metadata);
                if (metadata.suggest) suggestedActions.push(metadata);
            }
            const provider = getOmnibarProvider(member);
            if (provider) this.providers.push(provider);
        }
        for (const operation of Object.values(this.controlOperations())) {
            this.addAction(getActionMetadata(operation)!);
        }
        for (const metadata of suggestedActions) {
            this.providers.push({
                name: metadata.declaration.name,
                order: 0,
                suggest: query => metadata.suggest!(query).map(candidate => this.presentCandidate(metadata, candidate))
            });
        }
        const names = this.providers.map(provider => provider.name);
        if (new Set(names).size !== names.length) throw new Error("Duplicate omnibar provider");
        this.publicActions = Object.fromEntries(this.declarations
            .filter(declaration => declaration.exposure !== "omnibar")
            .map(declaration => [declaration.name, declaration]));
    }

    /** Reject ambiguous operation names before either MCP or the omnibar can use them. */
    private addAction(metadata: ActionMetadata): void {
        const name = metadata.declaration.name;
        if (this.actions.has(name)) throw new Error(`Duplicate action: ${name}`);
        this.actions.set(name, metadata);
    }

    /** The exporter reads these exact schemas; permission is derived from mutation. */
    get declarations() {
        return [...this.actions.values()].map(metadata => metadata.declaration);
    }

    /** Public controls are deliberate projections, not the full persisted state inventory. */
    get controlDeclarations() {
        return [...this.controls.values()].map(control => control.declaration);
    }

    /**
     * Derive the generic control operations from the discovered domain controls.
     * Their validators include each selector and value schema in the generated
     * manifest, so mapget checks the same assignment that the browser will apply.
     */
    private controlOperations() {
        const definitions = createControlActions(this.controlDeclarations);
        return {
            describe: action(definitions.describeControls, input => {
                const controls = [];
                const omissions: {control: string; reason: "byte_limit" | "item_limit"}[] = [];
                let budget = 208 * 1024;
                for (const {declaration} of this.controls.values()) {
                    if (input.controls && !input.controls.includes(declaration.name)) continue;
                    if (input.prefix !== undefined && !declaration.name.startsWith(input.prefix)) continue;
                    const metadata = {
                        ...declaration,
                        selectorSchema: z.toJSONSchema(declaration.selectorSchema, {
                            target: "draft-07", io: "input", reused: "inline"
                        }),
                        valueSchema: z.toJSONSchema(declaration.valueSchema, {
                            target: "draft-07", io: "input", reused: "inline"
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
            }),
            get: action(definitions.getControls, input => this.readControls(input.targets)),
            set: action(definitions.setControl, input => this.writeControl(input.target, input.value))
        };
    }

    /** Read current owner values within the shared output budget, reporting every omitted target. */
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
            if (!binding) {
                rejectAction("Unknown control", "invalid_arguments");
            }
            const context = new ControlReadContext(budget - 512);
            let entry: ControlReadResult["values"][number];
            try {
                const value = binding.read(selector, context);
                const validated = binding.declaration.valueSchema.safeParse(value);
                entry = validated.success
                    ? {target, value: validated.data}
                    : {target, unavailable: "value_out_of_contract"};
            } catch (error) {
                if (!(error instanceof ViewerActionFailure) || error.detail.code !== "not_available") {
                    throw error;
                }
                const reason = error.detail.reason;
                entry = {
                    target,
                    unavailable: reason === "first_person" || reason === "view_unavailable"
                        ? reason
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
            if (context.reason) {
                result.omissions.push({target, reason: context.reason});
            }
            if ("unavailable" in entry) {
                result.complete = false;
            }
        }
        result.complete &&= result.omissions.length === 0 && targets.length <= 32;
        return result;
    }

    /** Apply a validated owner setter and return its actual resulting value, including normalization. */
    writeControl(target: ControlTarget, value: unknown): ControlWriteResult {
        const {control: name, ...selector} = target;
        const binding = this.controls.get(name);
        if (!binding?.write) {
            rejectAction("Control is not writable", "invalid_arguments");
        }
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

    /** Adapts query/provider candidates to the exact registered operation, including saved-history payloads. */
    candidate<Input extends z.ZodType, Output extends z.ZodType, Result>(
        operation: Action<Input, Output, Result>,
        candidate: ActionSuggestion<z.input<Input>>
    ): SearchTarget {
        const metadata = getActionMetadata(operation)!;
        if (this.actions.get(metadata.declaration.name) !== metadata) {
            throw new Error(`Undiscovered candidate action: ${metadata.declaration.name}`);
        }
        return this.presentCandidate(metadata, candidate);
    }

    /** Keep menu lifetime checks at execution time, including saved-history arguments. */
    private presentCandidate<Input>(metadata: ActionMetadata, candidate: ActionSuggestion<Input>): SearchTarget {
        return {
            ...candidate,
            saveToHistory: candidate.saveToHistory ?? (() => false),
            validate: (query) => candidate.isCurrent() && candidate.validate(query),
            execute: async (query, payload) => {
                // An open menu may outlive a view, inspection, or configured provider.
                if (!candidate.isCurrent()) {
                    rejectAction("The suggested target is no longer available", "not_available");
                }
                const arguments_ =
                    typeof candidate.arguments === "function"
                        ? (candidate.arguments as (query: string, payload?: unknown) => Input)(query, payload)
                        : candidate.arguments;
                // Preserve synchronous browser actions such as opening a provider in a new tab.
                await metadata.execute(arguments_);
            }
        };
    }

    /** Collect current local choices in their established user-facing order. */
    omnibarTargets(query: string): SearchTarget[] {
        return [...this.providers]
            .sort((left, right) => left.order - right.order)
            .flatMap(provider => provider.suggest?.(query) ?? []);
    }

    /** The search panel's subscription owns debounce, cancellation and stale-result suppression. */
    asyncOmnibarTargets(query: string): Observable<SearchTarget[]> {
        const requests = this.providers.flatMap(provider => provider.search ? [provider.search(query)] : []);
        return requests.length ? forkJoin(requests).pipe(map(results => results.flat())) : of([]);
    }

    /** Shared dispatch for MCP adapters and local omnibar actions; owner methods remain directly callable. */
    execute(name: string, input: unknown, context: ActionContext = {}): unknown {
        const action = this.actions.get(name);
        if (!action) {
            rejectAction(`Unknown action: ${name}`, "invalid_arguments");
        }
        return action.execute(input, context);
    }

    /** Check whether the composed features contributed the named operation. */
    has(name: string): boolean {
        return this.actions.has(name);
    }

}
