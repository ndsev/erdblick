import MainModuleFactory, {MainModule as ErdblickCore} from '../../build/libs/core/erdblick-core';
import {Injectable} from "@angular/core";

@Injectable({providedIn: 'root'})
export class CoreService {

    coreLib: ErdblickCore | undefined;

    initializeLibrary(): Promise<void> {
        return MainModuleFactory().then((coreLib: ErdblickCore) => {
            console.log("  ...done.")
            this.coreLib = coreLib;

            this.coreLib.setExceptionHandler((excType: string, message: string) => {
                throw new Error(`${excType}: ${message}`);
            });
        });
    }
}
