import type { z } from "zod";
import type {
    ActionCandidateHistory,
    AppAction,
    AppActionCandidate,
    AppControl,
    ControlReadContext
} from "./action.model";

/**
 * The registration surface available to domain contributors.
 * It binds declarations to their handlers without exposing dispatch, catalog
 * queries or the lifetime of the Angular registry service.
 */
export interface AppActionRegistration {
    /** Register a command and, when useful, its parameterized omnibar choices. */
    registerAction<Input extends z.ZodType, Output extends z.ZodType>(
        declaration: AppAction<Input, Output>,
        execute: (input: z.infer<Input>, signal?: AbortSignal) => z.infer<Output> | Promise<z.infer<Output>>,
        candidates?: (query: string, history?: ActionCandidateHistory) => AppActionCandidate<z.infer<Input>>[]
    ): void;

    /** Register a state control with its ordinary domain read/write operations. */
    registerControl<Selector extends z.ZodObject, Value extends z.ZodType>(
        declaration: AppControl<Selector, Value>,
        binding: {
            read(selector: z.infer<Selector>, context: ControlReadContext): z.infer<Value>;
            write?: (selector: z.infer<Selector>, value: z.infer<Value>) => void;
            defaultTargets?: () => z.infer<Selector>[];
        }
    ): void;
}

/**
 * Application controllers contribute explicit public operations and controls.
 * Registration only supplies metadata and bound callbacks: it must not fetch data,
 * start workers, read a renderer, or execute a callback. Both browser startup and
 * the Node catalog build call these methods on the same Angular services.
 *
 * A controller implements the methods it needs; a control-only owner does not
 * need an empty registerActions method (and vice versa). All controls are
 * registered before the registry derives its generic read/write tools.
 */
export interface AppActionContributor {
    registerActions?(registry: AppActionRegistration): void;
    registerControls?(registry: AppActionRegistration): void;
}
