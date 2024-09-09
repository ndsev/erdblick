import {Injectable} from "@angular/core";
import {BehaviorSubject, Subject} from "rxjs";


@Injectable()
export class EditorService {

    updateEditorState: Subject<boolean> = new Subject<boolean>();
    editedSaveTriggered: Subject<boolean> = new Subject<boolean>();
    configEditedStateData: BehaviorSubject<string> = new BehaviorSubject<string>("");
    editedData: string = "";

    constructor() {}
}