import type {z} from "zod";
import {rejectAction} from "./action-utils";
import type {ActionSuggestion} from "./omnibar";

/**
 * The public description belongs to the operation that implements it. Mutation
 * determines MCP permission; an owner does not declare a second permission flag.
 */
export interface ActionDeclaration<Input extends z.ZodType = z.ZodType, Output extends z.ZodType = z.ZodType> {
    name: string;
    description: string;
    mutation: boolean;
    inputSchema: Input;
    outputSchema: Output;
    /** Local commands use the same validation without becoming MCP tools. */
    exposure?: "omnibar";
}

/** Cancellation is passed into resource work and rechecked before applying its result. */
export interface ActionContext {
    signal?: AbortSignal;
}

/**
 * Metadata lives on the callable, outside the SignalStore's application values.
 * Discovery reads this property without invoking the operation or its suggestions.
 */
const actionMetadata = Symbol("viewer action");
export interface ActionMetadata {
    readonly declaration: ActionDeclaration;
    readonly execute: (input: unknown, context?: ActionContext) => unknown;
    readonly suggest?: (query: string) => ActionSuggestion<unknown>[];
}

/** A typed UI method and the operation discovered by MCP are the same function. */
export type Action<Input extends z.ZodType, Output extends z.ZodType, Result> = (
    (input: z.input<Input>, context?: ActionContext) => Result extends Promise<unknown>
        ? Promise<z.output<Output>>
        : z.output<Output>
) & {readonly [actionMetadata]: ActionMetadata};

/**
 * Attach discovery information to an ordinary method and validate its boundary.
 * Synchronous handlers remain synchronous, including browser commands that need
 * the current click gesture. Async handlers retain their own cancellation and
 * target-lifetime checks; the catalog cannot infer when an effect has occurred.
 */
export function action<
    Input extends z.ZodType,
    Output extends z.ZodType,
    Result extends z.input<Output> | Promise<z.input<Output>>
>(
    declaration: ActionDeclaration<Input, Output>,
    execute: (input: z.output<Input>, context: ActionContext) => Result,
    omnibar?: {suggest: (query: string) => ActionSuggestion<z.input<Input>>[]}
): Action<Input, Output, Result> {
    const invoke = (input: unknown, context: ActionContext = {}) => {
        if (context.signal?.aborted) {
            rejectAction("Action cancelled", "cancelled");
        }
        const parsed = declaration.inputSchema.safeParse(input);
        if (!parsed.success) {
            rejectAction("Arguments do not match the action schema", "invalid_arguments");
        }
        const result = execute(parsed.data, context);
        return result instanceof Promise
            ? result.then(value => declaration.outputSchema.parse(value))
            : declaration.outputSchema.parse(result);
    };
    return Object.assign(invoke, {
        [actionMetadata]: {declaration, execute: invoke, suggest: omnibar?.suggest}
    }) as Action<Input, Output, Result>;
}

/** Inspect one store member without calling it, including native signal members. */
export function getActionMetadata(member: unknown): ActionMetadata | undefined {
    if (typeof member !== "function" || !(actionMetadata in member)) {
        return undefined;
    }
    return Reflect.get(member, actionMetadata) as ActionMetadata;
}
