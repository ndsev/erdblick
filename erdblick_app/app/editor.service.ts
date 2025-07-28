import {Injectable} from "@angular/core";
import {BehaviorSubject, Subject} from "rxjs";

@Injectable()
export class EditorService {

    // TODO: Change to a stack of references to support many editors.
    // NOTE: Currently only supports one editor at a time. A stack would allow
    // multiple editors to be open simultaneously (e.g., style editor + datasources editor).
    styleEditorVisible: boolean = false;
    datasourcesEditorVisible: boolean = false;
    updateEditorState: Subject<boolean> = new Subject<boolean>();
    editedSaveTriggered: Subject<boolean> = new Subject<boolean>();
    editedStateData: BehaviorSubject<string> = new BehaviorSubject<string>("");
    editableData: string = "";
    readOnly: boolean = false;

    constructor() {}
}