import type {Rectangle} from "../integrations/geo";

/** Camera target plus an optional exact point marker, used by built-in and configured parsers. */
export interface SearchJump {
    target: number[] | Rectangle;
    markerPosition?: number[];
}
export type SearchJumpResult = number[] | Rectangle | SearchJump;

/** Legacy plugin point arrays also carry a marker; rectangle-only jumps do not. */
export function normalizeSearchJumpResult(result: SearchJumpResult): SearchJump {
    if (Array.isArray(result)) return {target: result, markerPosition: result};
    return "target" in result ? result : {target: result};
}

/** One live, recognizable choice in the omnibar. Runtime providers are never exported to MCP. */
export interface SearchTarget {
    id: string;
    icon: string;
    iconType?: "prime" | "material";
    color: string;
    name: string;
    label: string;
    enabled: boolean;
    acceptsEmptyInput?: boolean;
    saveToHistory?: (value: string) => boolean;
    payload?: unknown;
    jump?: (value: string, payload?: unknown) => SearchJumpResult | undefined | Promise<SearchJumpResult | undefined>;
    execute?: (value: string, payload?: unknown) => void | Promise<void>;
    validate: (value: string) => boolean;
}

/** Parameterized public actions are chosen from live candidates, never replayed from old history. */
export interface ActionSuggestion<Input> extends Omit<SearchTarget, "execute" | "jump"> {
    arguments: Input | ((query: string, payload?: unknown) => Input);
    isCurrent(): boolean;
}
