import {NgModule} from '@angular/core';
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
import {MenuComponent} from "./menu.component";
import {JumpTargetService} from "./jump.service";
import {MapService} from "./map.service";
import {InputSwitchModule} from "primeng/inputswitch";
import {SliderModule} from "primeng/slider";
import {StyleService} from "./style.service";
import {MapPanelComponent} from "./map.panel.component";

@NgModule({
    declarations: [
        AppComponent,
        MenuComponent,
        MapPanelComponent
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
        SliderModule
    ],
    providers: [
        MapService,
        MessageService,
        InfoMessageService,
        JumpTargetService,
        StyleService
    ],
    bootstrap: [AppComponent]
})
export class AppModule {
}
