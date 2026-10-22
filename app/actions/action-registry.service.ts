import { Injectable } from "@angular/core";
import { z } from "zod";
import { deepCopy, deepEquals } from "../state/app-state";
import { AppStateService } from "../state/app-state.service";
import {
    ActionCandidateHistory,
    AppAction,
    AppActionCandidate,
    AppControl,
    ControlReadContext,
    jsonByteLength,
    RegisteredActionCandidate,
    rejectAction,
    VIEWER_ACTION_RESULT_BYTES,
    VIEWER_ACTION_TARGET_LIMIT
} from "./app-action";
import type { AppActionContributor } from "./app-action-contributor";
import { createControlActions, describeControls, viewerJsonSchema } from "./control-actions";
import { ViewerActionFailure } from "./viewer-action-relay.contract";

/** Infer generic control payloads from the same schemas used at the boundary. */
type ControlActions = ReturnType<typeof createControlActions>;
type ControlInput<Name extends keyof ControlActions> = z.infer<ControlActions[Name]["inputSchema"]>;
type ControlOutput<Name extends keyof ControlActions> = z.infer<ControlActions[Name]["outputSchema"]>;

type ControlTarget = {
    control: string;
    [key: string]: unknown;
};
interface RegisteredControl {
    declaration: AppControl;
    read(selector: Record<string, unknown>, context: ControlReadContext): unknown;
    write?: (selector: Record<string, unknown>, value: unknown) => void;
    defaultTargets?: () => Record<string, unknown>[];
}

/**
 * Explicit boundary dispatch, schema checks and response bounds. Owners register
 * ordinary methods; this service neither discovers stored values nor owns domains.
 */
@Injectable({ providedIn: "root" })
export class ActionRegistry {
    private readonly actions = new Map<string, {
        declaration: AppAction;
        execute: (input: unknown, signal?: AbortSignal) => unknown;
        candidates?: (query: string, history?: ActionCandidateHistory) => AppActionCandidate[];
    }>();
    private readonly controls = new Map<string, RegisteredControl>();
    private sealed = false;

    constructor(private readonly persistence: AppStateService) { }

    /**
     * Run both registration phases on the application's controllers. This same
     * path is used by browser startup, the Node catalog build and owner fixtures.
     */
    registerContributors(controllers: readonly AppActionContributor[]): void {
        for (const controller of controllers) controller.registerControls?.(this);
        for (const controller of controllers) controller.registerActions?.(this);
        this.sealRegistration();
    }

    /**
     * Binds one declared action to its owner's method. Optional live candidates
     * supply omnibar arguments to that same method; execution validates both
     * arguments and result, including asynchronous failures.
     */
    registerAction<Input extends z.ZodType, Output extends z.ZodType>(
        declaration: AppAction<Input, Output>,
        execute: (input: z.infer<Input>, signal?: AbortSignal) => z.infer<Output> | Promise<z.infer<Output>>,
        candidates?: (query: string, history?: ActionCandidateHistory) => AppActionCandidate<z.infer<Input>>[]
    ): void {
        if (this.sealed) {
            throw new Error(`Action registration is closed: ${declaration.name}`);
        }
        if (this.actions.has(declaration.name)) {
            throw new Error(`Duplicate action: ${declaration.name}`);
        }
        this.actions.set(declaration.name, {
            declaration,
            execute: execute as (input: unknown, signal?: AbortSignal) => unknown,
            candidates
        });
    }

    /** Queries live owner choices without running an action or loading network data. */
    getCandidates(query: string, history?: ActionCandidateHistory): RegisteredActionCandidate[] {
        const candidates: RegisteredActionCandidate[] = [];
        const ids = new Set<string>();
        for (const { declaration, candidates: provide } of this.actions.values()) {
            for (const candidate of provide?.(query, history) ?? []) {
                if (!candidate.id || ids.has(candidate.id)) {
                    throw new Error(`Duplicate or empty action candidate ID: ${candidate.id}`);
                }
                ids.add(candidate.id);
                candidates.push({ ...candidate, action: declaration.name });
            }
        }
        return candidates;
    }

    /**
     * Binds an explicit public value to owner readers/writers. Default targets
     * select the bounded overview; they do not discover or register stored slots.
     * A writable declaration must have exactly one owner write binding.
     */
    registerControl<Selector extends z.ZodObject, Value extends z.ZodType>(
        declaration: AppControl<Selector, Value>,
        binding: {
            read(selector: z.infer<Selector>, context: ControlReadContext): z.infer<Value>;
            write?: (selector: z.infer<Selector>, value: z.infer<Value>) => void;
            defaultTargets?: () => z.infer<Selector>[];
        }
    ): void {
        if (this.sealed) {
            throw new Error(`Control registration is closed: ${declaration.name}`);
        }
        if (this.controls.has(declaration.name)) {
            throw new Error(`Duplicate control: ${declaration.name}`);
        }
        if (declaration.writable !== !!binding.write) {
            throw new Error(`Control write binding does not match its declaration: ${declaration.name}`);
        }
        this.controls.set(declaration.name, { declaration, ...binding } as RegisteredControl);
    }

    /**
     * Finish registration once all controllers have contributed. Control-tool
     * schemas are derived here, so a new control has exactly one declaration.
     */
    sealRegistration(): void {
        if (this.sealed) throw new Error("Action registration is already closed.");
        const controls = this.controlDeclarations;
        const tools = createControlActions(controls);
        this.registerAction(tools.describeControls, input => this.describe(input));
        this.registerAction(tools.getControls, input => this.read(input));
        this.registerAction(tools.setControl, input => this.write(input));
        this.sealed = true;
    }

    /** Public tools shared by the MCP relay, document adapter and build collector. */
    get publicActions(): Readonly<Record<string, AppAction>> {
        return Object.fromEntries([...this.actions.values()]
            .filter(entry => entry.declaration.exposure !== "omnibar")
            .map(entry => [entry.declaration.name, entry.declaration] as const)
            .sort(([left], [right]) => left.localeCompare(right, "en")));
    }

    /** Stable metadata order makes catalog hashes independent of construction order. */
    private get controlDeclarations(): AppControl[] {
        return [...this.controls.values()].map(entry => entry.declaration)
            .sort((left, right) => left.name.localeCompare(right.name, "en"));
    }

    /**
     * Serializes the registered public surface without running handlers or live
     * omnibar providers. The v1 native envelope calls controls channels.
     */
    catalog() {
        if (!this.sealed) throw new Error("Action registration must finish before catalog export.");
        return {
            formatVersion: 1 as const,
            actions: Object.values(this.publicActions).map(action => ({
                name: action.name,
                description: action.description,
                mutation: action.mutation,
                permission: action.mutation ? "viewer-control" : "viewer-read",
                inputSchema: viewerJsonSchema(action.inputSchema),
                outputSchema: viewerJsonSchema(action.outputSchema)
            })),
            channels: describeControls(this.controlDeclarations)
        };
    }

    /** Local omnibar and remote adapters share validation and owner dispatch. */
    execute(name: string, input: unknown, signal?: AbortSignal): unknown {
        if (signal?.aborted) {
            rejectAction("Action cancelled", "cancelled");
        }
        const action = this.actions.get(name);
        if (!action) {
            rejectAction("Unsupported viewer action", "unsupported_action");
        }
        const parsed = action.declaration.inputSchema.safeParse(input);
        if (!parsed.success) {
            rejectAction("Arguments do not match the action schema", "invalid_arguments");
        }
        const validate = (result: unknown) => {
            const checked = action.declaration.outputSchema.safeParse(result);
            if (!checked.success || jsonByteLength(checked.data) > VIEWER_ACTION_RESULT_BYTES) {
                throw new ViewerActionFailure({
                    code: "internal_error",
                    message: "Owner returned a result outside its contract",
                    outcome: action.declaration.mutation ? "unknown" : "not_applied"
                });
            }
            return checked.data;
        };
        const result = action.execute(parsed.data, signal);
        return result instanceof Promise ? result.then(validate) : validate(result);
    }

    /** Returns declaration metadata without reading live owners or materializing defaults. */
    private describe(input: ControlInput<"describeControls">) {
        return {
            observedAt: new Date().toISOString(),
            controls: describeControls(this.controlDeclarations).filter(control =>
                (!input.controls || input.controls.includes(control.name)) &&
                (!input.prefix || control.name.startsWith(input.prefix))
            ),
            complete: true,
            omissions: []
        };
    }

    /**
     * Reads explicit targets or the owners' default overview within one response
     * budget. Unavailable values and omitted entries remain visible to callers.
     */
    private read(
        input: ControlInput<"getControls">
    ): ControlOutput<"getControls"> {
        const defaults = () => [...this.controls.values()].flatMap(binding =>
            (binding.defaultTargets?.() ?? []).map(selector => ({
                control: binding.declaration.name,
                ...selector
            }))
        );
        const requested = (input.targets ?? defaults()) as ControlTarget[];
        const targets = requested.slice(0, VIEWER_ACTION_TARGET_LIMIT);
        const values: ControlOutput<"getControls">["values"] = [];
        const omissions: ControlOutput<"getControls">["omissions"] = [];
        let budget = VIEWER_ACTION_RESULT_BYTES - 48 * 1024;
        if (requested.length > targets.length) {
            omissions.push({
                target: requested[targets.length],
                reason: "item_limit",
                omittedCount: requested.length - targets.length
            });
        }
        for (const target of targets) {
            if (budget < 1024) {
                omissions.push({ target, reason: "byte_limit" });
                continue;
            }
            const { binding, selector } = this.resolve(target);
            const context = new ControlReadContext(budget);
            let entry: ControlOutput<"getControls">["values"][number];
            try {
                const parsed = binding.declaration.valueSchema.safeParse(binding.read(selector, context));
                entry = parsed.success
                    ? { target, value: parsed.data }
                    : { target, unavailable: "value_out_of_contract" };
            } catch (error) {
                if (!(error instanceof ViewerActionFailure) || error.detail.code !== "not_available") {
                    throw error;
                }
                const reason = error.detail.reason;
                entry = {
                    target,
                    unavailable: reason === "view_unavailable" || reason === "first_person"
                        ? reason : "target_unavailable"
                };
            }
            const bytes = jsonByteLength(entry);
            if (bytes > budget) {
                omissions.push({ target, reason: "byte_limit" });
                continue;
            }
            budget -= bytes;
            values.push(entry);
            if (context.reason) {
                omissions.push({ target, reason: context.reason });
            }
        }
        return {
            observedAt: new Date().toISOString(),
            values,
            complete: omissions.length === 0 && values.every(value => !("unavailable" in value)),
            omissions
        };
    }

    /**
     * Applies one validated assignment through the owner, then reports its actual
     * result. The before-value copy detects changes without exposing mutable data.
     */
    private write(input: ControlInput<"setControl">) {
        const target = input.target as ControlTarget;
        const { binding, selector } = this.resolve(target);
        if (!binding.write) {
            rejectAction("This control is read-only", "invalid_arguments");
        }
        const context = new ControlReadContext(VIEWER_ACTION_RESULT_BYTES);
        const before = deepCopy(binding.read(selector, context));
        // This generic boundary makes compound control assignments coherent; owner
        // methods also use transactions for their ordinary application workflows.
        this.persistence.transaction(() => {
            binding.write!(selector, binding.declaration.valueSchema.parse(input.value));
        });
        const value = binding.read(selector, context);
        return {
            status: "applied" as const,
            target,
            value,
            changed: !deepEquals(before, value),
            readiness: { status: "unknown" as const }
        };
    }

    /** Resolves the named owner binding and validates only its public selector fields. */
    private resolve(target: ControlTarget) {
        const binding = this.controls.get(target.control);
        if (!binding) {
            rejectAction("Unsupported control", "invalid_arguments");
        }
        const { control: _name, ...rawSelector } = target;
        const parsed = binding.declaration.selectorSchema.safeParse(rawSelector);
        if (!parsed.success) {
            rejectAction("Selector does not match the control schema", "invalid_arguments");
        }
        return { binding, selector: parsed.data as Record<string, unknown> };
    }
}
