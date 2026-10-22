import type { ActionRegistry } from "./action-registry.service";

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
    registerActions?(registry: ActionRegistry): void;
    registerControls?(registry: ActionRegistry): void;
}
