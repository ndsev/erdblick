import {Injectable} from "@angular/core";
import {InfoMessageService} from "./info.service";


@Injectable()
export class ClipboardService {

    constructor(private messageService: InfoMessageService) {}

    copyToClipboard(text: string, info?: string) {
        try {
            navigator.clipboard.writeText(text).then(
                () => {
                    this.messageService.showSuccess(info ?? "Copied content to clipboard!");
                },
                () => {
                    this.messageService.showError("Could not copy content to clipboard.");
                }
            );
        } catch (error) {
            console.error(error);
        }
    }
}