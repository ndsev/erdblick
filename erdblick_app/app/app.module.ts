import {APP_INITIALIZER, NgModule} from '@angular/core';
import {BrowserModule} from '@angular/platform-browser';

import {AppRoutingModule} from './app-routing.module';
import {AppComponent} from './app.component';
import {HttpClientModule} from "@angular/common/http";
import {SpeedDialModule} from "primeng/speeddial";
import {DialogModule} from "primeng/dialog";
import {BrowserAnimationsModule} from "@angular/platform-browser/animations";
import {AnimateModule} from "primeng/animate";
import {FormsModule} from "@angular/forms";
import {ScrollPanelModule} from "primeng/scrollpanel";
import {TreeModule} from "primeng/tree";
import {AccordionModule} from "primeng/accordion";
import {OverlayPanelModule} from "primeng/overlaypanel";
import {DividerModule} from "primeng/divider";
import {PanelMenuModule} from "primeng/panelmenu";
import {TreeTableModule} from "primeng/treetable";
import {ToastModule} from "primeng/toast";
import {MessageService} from "primeng/api";
import {InputNumberModule} from "primeng/inputnumber";
import {FieldsetModule} from "primeng/fieldset";
import {InfoMessageService} from "./info.service";
import {SearchMenuComponent} from "./search-menu.component";
import {JumpTargetService} from "./jump.service";
import {MapService} from "./map.service";
import {InputSwitchModule} from "primeng/inputswitch";
import {SliderModule} from "primeng/slider";
import {StyleService} from "./style.service";
import {MapPanelComponent} from "./map.panel.component";
import {InspectionPanelComponent} from "./inspection.panel.component";
import {InspectionService} from "./inspection.service";
import {ParametersService} from "./parameters.service";
import {PreferencesComponent} from "./preferences.component";
import {FileUploadModule} from "primeng/fileupload";
import {EditorComponent} from "./editor.component";
import {ErdblickViewComponent} from "./view.component";
import {initialiseLibrary} from "./wasm";

export function initialiseServices(styleService: StyleService) {
    return () => {
        return initialiseLibrary().then(() => {
            return styleService.initialiseStyles();
        });
    }
}

@NgModule({
    declarations: [
        AppComponent,
        SearchMenuComponent,
        MapPanelComponent,
        InspectionPanelComponent,
        PreferencesComponent,
        EditorComponent,
        ErdblickViewComponent
    ],
    imports: [
        BrowserModule,
        BrowserAnimationsModule,
        AnimateModule,
        AppRoutingModule,
        HttpClientModule,
        SpeedDialModule,
        DialogModule,
        FormsModule,
        ScrollPanelModule,
        TreeModule,
        AccordionModule,
        OverlayPanelModule,
        DividerModule,
        PanelMenuModule,
        TreeTableModule,
        ToastModule,
        InputNumberModule,
        FieldsetModule,
        InputSwitchModule,
        SliderModule,
        FileUploadModule
    ],
    providers: [
        {
            provide: APP_INITIALIZER,
            useFactory: initialiseServices,
            deps: [StyleService],
            multi: true
        },
        MapService,
        MessageService,
        InfoMessageService,
        JumpTargetService,
        InspectionService,
        ParametersService,
    ],
    bootstrap: [AppComponent]
})
export class AppModule {
}
