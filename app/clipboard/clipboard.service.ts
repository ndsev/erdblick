import {Injectable} from "@angular/core";
import {AppAlertService} from "../alert/app-alert.service";
import {InfoMessageService} from "../diagnostics/info.service";


@Injectable()
/** Clipboard helper that falls back to a manual copy dialog outside secure contexts. */
export class ClipboardService {

    constructor(private messageService: InfoMessageService, private alerts: AppAlertService) {}

    /**
     * Copies text to the system clipboard. The asynchronous write falls back to a
     * manual-copy dialog when unavailable or rejected. Synchronous setup failures
     * are logged; completion is not awaited.
     */
    copyToClipboard(text: string, info?: string) {
        try {
            const hint = "The clipboard is not available due to missing secure context (HTTPS). Copy the content manually:";

            if (!globalThis.isSecureContext || !(navigator as any)?.clipboard?.writeText) {
                this.alerts.showAlertDialogDefault("Clipboard Content", text, true, hint);
                return;
            }

            navigator.clipboard.writeText(text).then(
                () => {
                    this.messageService.showSuccess(info ?? "Copied content to clipboard!");
                },
                () => {
                    // Fall back to manual copy dialog on failure
                    this.alerts.showAlertDialogDefault("Clipboard Content", text, true, hint);
                }
            );
        } catch (error) {
            console.error(error);
        }
    }
}
