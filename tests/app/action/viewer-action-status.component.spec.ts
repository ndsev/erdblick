import "@angular/compiler";
import {
    describe,
    expect,
    it
} from "vitest";
import {BehaviorSubject} from "rxjs";
import {ViewerActionStatusComponent} from "../../../app/action/viewer-action-status.component";

describe("MCP activity indicator", () => {
    it.each([
        {enabled: true, message: "ready", viewerTools: 0, active: false, severity: "secondary"},
        {enabled: true, message: "ready", viewerTools: 0, active: true, severity: "success"},
        {enabled: true, message: "waiting", viewerTools: 0, active: false, severity: "danger"},
        {enabled: true, message: "connecting", viewerTools: 0, active: false, severity: "danger"},
        {enabled: true, message: "waiting", viewerTools: 1, active: true, severity: "danger"},
        {enabled: false, message: "waiting", viewerTools: 1, active: false, severity: "secondary"},
        {enabled: false, message: "waiting", viewerTools: 1, active: true, severity: "success"},
        {enabled: false, message: "waiting", viewerTools: 0, active: false, severity: "danger"}
    ])("shows $severity for backend enabled=$enabled message=$message, WebMCP tools=$viewerTools, pending=$active", ({enabled, message, viewerTools, active, severity}) => {
        const ui = new ViewerActionStatusComponent(
            {availability$: new BehaviorSubject({enabled, message}), hasPendingAction: active} as never,
            {status$: new BehaviorSubject({viewerTools})} as never
        );
        expect(ui.buttonSeverity).toBe(severity);
    });
});
