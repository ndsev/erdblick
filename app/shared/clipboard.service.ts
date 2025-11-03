import {Injectable} from "@angular/core";
import {InfoMessageService} from "./info.service";


@Injectable()
export class ClipboardService {

    constructor(private messageService: InfoMessageService) {}

    copyToClipboard(text: string, info?: string) {
        try {
            const hint = "The clipboard is not available due to missing secure context (HTTPS). Copy the content manually:";

            if (!globalThis.isSecureContext || !(navigator as any)?.clipboard?.writeText) {
                this.messageService.showAlertDialogDefault("Clipboard Content", text, true, hint);
                return;
            }

            navigator.clipboard.writeText(text).then(
                () => {
                    this.messageService.showSuccess(info ?? "Copied content to clipboard!");
                },
                () => {
                    // Fall back to manual copy dialog on failure
                    this.messageService.showAlertDialogDefault("Clipboard Content", text, true, hint);
                }
            );
        } catch (error) {
            console.error(error);
        }
    }
}
