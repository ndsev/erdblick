/**
 * Saved style visibility and the style currently open in the editor. Pure edits
 * to these AppStates can happen without loading style files or starting the
 * compiler; those operations remain in MapStyleService.
 */
import { Injectable } from "@angular/core";
import { z } from "zod";
import { AppStateService } from "../appstate/appstate.service";

@Injectable({ providedIn: "root" })
export class MapStyleState {
    constructor(private readonly persistence: AppStateService) {}

    readonly styleVisibilityState = this.persistence.registerState<Record<string, boolean>>({
        name: "styleVisiblity",
        schema: z.record(z.string(), z.coerce.boolean()),
        defaultValue: {}
    });

    readonly styleEditorTargetState = this.persistence.registerState<string | null>({
        name: "styleEditorTarget",
        defaultValue: null,
        schema: z.string().nullable()
    });

    get styleVisibility() {
        return this.styleVisibilityState.getValue();
    }

    set styleVisibility(val: Record<string, boolean>) {
        this.styleVisibilityState.next(val);
    }

    get styleEditorTargetId() {
        return this.styleEditorTargetState.getValue();
    }

    set styleEditorTargetId(val: string | null) {
        this.styleEditorTargetState.next(val);
    }

    /** Returns whether the style is visible in the persisted style tree. */
    getStyleVisibility(styleId: string, fallback: boolean = true): boolean {
        if (this.styleVisibility.hasOwnProperty(styleId)) {
            return this.styleVisibility[styleId];
        }
        return fallback;
    }

    /** Updates the persisted visibility flag for one style. */
    setStyleVisibility(styleId: string, val: boolean) {
        this.styleVisibilityState.next({ ...this.styleVisibility, [styleId]: val });
    }

    /** Removes stale visibility when a locally imported style identity is deleted. */
    removeStyleVisibility(styleId: string) {
        if (!Object.prototype.hasOwnProperty.call(this.styleVisibility, styleId)) {
            return;
        }
        const next = { ...this.styleVisibility };
        delete next[styleId];
        this.styleVisibility = next;
    }
}
