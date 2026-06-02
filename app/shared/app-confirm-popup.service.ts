import {Injectable} from "@angular/core";
import {Confirmation, ConfirmationService} from "primeng/api";

export type AppConfirmPopupSeverity = "success" | "info" | "warn" | "error";

export interface AppConfirmPopupOptions {
    key: string;
    target: EventTarget;
    header: string;
    message: string;
    severity: AppConfirmPopupSeverity;
    accept: () => void;
    reject?: () => void;
}

export interface AppConfirmation extends Confirmation {
    severity?: AppConfirmPopupSeverity;
}

@Injectable({providedIn: "root"})
/** Wraps PrimeNG confirmation popups behind the app's own confirm contract. */
export class AppConfirmPopupService {
    constructor(private readonly confirmationService: ConfirmationService) {}

    /** Opens one keyed confirmation popup with the standard app copy and severity model. */
    confirm(options: AppConfirmPopupOptions): void {
        this.confirmationService.confirm({
            key: options.key,
            target: options.target,
            header: options.header,
            message: options.message,
            accept: options.accept,
            reject: options.reject,
            severity: options.severity
        } as AppConfirmation);
    }

    /** Closes the active confirmation popup. */
    close(): void {
        this.confirmationService.close();
    }
}
