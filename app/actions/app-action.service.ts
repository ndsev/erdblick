import {Injectable} from "@angular/core";
import {z} from "zod";

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
    private readonly actions = new Map<string, {
        declaration: ActionDeclaration;
        execute: (input: unknown, context: ActionContext) => unknown;
    }>();

    registerAction<Input extends z.ZodType, Output extends z.ZodType>(
        declaration: ActionDeclaration<Input, Output>,
        execute: (input: z.output<Input>, context: ActionContext) => z.input<Output> | Promise<z.input<Output>>
    ): void {
        if (this.actions.has(declaration.name)) throw new Error(`Duplicate action: ${declaration.name}`);
        this.actions.set(declaration.name, {declaration, execute: (input, context) => {
            context.signal?.throwIfAborted();
            const result = execute(declaration.inputSchema.parse(input), context);
            return result instanceof Promise
                ? result.then(value => declaration.outputSchema.parse(value))
                : declaration.outputSchema.parse(result);
        }});
    }

    execute(name: string, input: unknown, context: ActionContext = {}): unknown {
        const action = this.actions.get(name);
        if (!action) throw new Error(`Action owner was not registered: ${name}`);
        return action.execute(input, context);
    }

    has(name: string): boolean { return this.actions.has(name); }

    /** Fail startup on missing/extra bindings instead of advertising unusable tools. */
    assertComplete(declarations: readonly ActionDeclaration[]): void {
        const expected = new Set(declarations.map(action => action.name));
        if (expected.size !== declarations.length) throw new Error("Duplicate action in exported catalog");
        const mismatched = declarations.filter(action => this.actions.get(action.name)?.declaration !== action)
            .map(action => action.name);
        const missing = [...expected].filter(name => !this.actions.has(name));
        const extra = [...this.actions.keys()].filter(name => !expected.has(name));
        if (missing.length || extra.length || mismatched.length) {
            throw new Error(`Action registration mismatch: missing ${missing}; extra ${extra}; contract ${mismatched}`);
        }
    }
}
