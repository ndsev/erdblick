import {inject} from "@angular/core";
import {AppStateService} from "../shared/appstate.service";
import {ownerState} from "./style-editor-request.service.state";

import {Injectable} from "@angular/core";
import {Subject} from "rxjs";

@Injectable({providedIn: "root"})
/** Carries style-editor requests from UI surfaces that do not own the editor dialog. */
export class StyleEditorRequestService {
    private readonly stateService = inject(AppStateService);

    readonly styleEditorTargetState = this.stateService.register(
        ownerState.styleEditorTarget,
        "styleEditor",
        "styleEditorTarget"
    );

    get styleEditorTargetId() {
        return this.styleEditorTargetState.getValue();
    }

    set styleEditorTargetId(val: string | null) {
        this.styleEditorTargetState.next(val);
    }

    readonly requests = new Subject<string>();

    /** Requests that the existing style editor open the supplied full style id. */
    open(styleId: string): void {
        this.requests.next(styleId);
    }
}
