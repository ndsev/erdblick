import {Injectable} from "@angular/core";
import {Subject} from "rxjs";

@Injectable({providedIn: "root"})
/** Carries style-editor requests from UI surfaces that do not own the editor dialog. */
export class StyleEditorRequestService {
    readonly requests = new Subject<string>();

    /** Requests that the existing style editor open the supplied full style id. */
    open(styleId: string): void {
        this.requests.next(styleId);
    }
}
