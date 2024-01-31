import {Injectable} from "@angular/core";
import {MessageService} from "primeng/api";

@Injectable({providedIn: 'root'})
export class InfoMessageService {
    constructor(private messageService: MessageService) { };

    showError(content: string) {
        this.messageService.add({ key: 'tc', severity: 'error', summary: 'Error', detail: content });
        return;
    }

    showSuccess(content: string) {
        this.messageService.add({ key: 'tc', severity: 'success', summary: 'Success', detail: content });
        return;
    }
}