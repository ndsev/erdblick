import {APP_INITIALIZER, NgModule} from '@angular/core';
import {BrowserModule} from '@angular/platform-browser';

import {AppRoutingModule} from './app-routing.module';
import {AppComponent} from './app.component';
import {HttpClientModule, provideHttpClient, withInterceptorsFromDi} from "@angular/common/http";
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
import {AlertDialogComponent, InfoMessageService} from "./info.service";
import {EnterSelectDirective, SearchPanelComponent} from "./search.panel.component";
import {JumpTargetService} from "./jump.service";
import {MapService} from "./map.service";
import {InputSwitchModule} from "primeng/inputswitch";
import {SliderModule} from "primeng/slider";
import {StyleService} from "./style.service";
import {FeatureSearchComponent} from "./feature.search.component";
import {MapPanelComponent} from "./map.panel.component";
import {InspectionPanelComponent} from "./inspection.panel.component";
import {FeaturePanelComponent} from "./feature.panel.component";
import {SourceDataPanelComponent} from "./sourcedata.panel.component";
import {InspectionService} from "./inspection.service";
import {ParametersService} from "./parameters.service";
import {PreferencesComponent} from "./preferences.component";
import {FileUploadModule} from "primeng/fileupload";
import {EditorComponent} from "./editor.component";
import {ErdblickViewComponent} from "./view.component";
import {CoordinatesPanelComponent} from "./coordinates.panel.component";
import {initializeLibrary} from "./wasm";
import {CheckboxModule} from "primeng/checkbox";
import {InputTextModule} from "primeng/inputtext";
import {SidePanelService} from "./sidepanel.service";
import {MenuModule} from "primeng/menu";
import {CardModule} from "primeng/card";
import {CoordinatesService} from "./coordinates.service";
import {ColorPickerModule} from "primeng/colorpicker";
import {ListboxModule} from "primeng/listbox";
import {FeatureSearchService} from "./feature.search.service";
import {ClipboardService} from "./clipboard.service";
import {MultiSelectModule} from "primeng/multiselect";
import {ButtonGroupModule} from "primeng/buttongroup";
import {BreadcrumbModule} from "primeng/breadcrumb";
import {TableModule} from "primeng/table";
import {HighlightSearch} from "./highlight.pipe";
import {TreeTableFilterPatchDirective} from "./treetablefilter-patch.directive";
import {InputTextareaModule} from "primeng/inputtextarea";
import {FloatLabelModule} from "primeng/floatlabel";
import {TabViewModule} from "primeng/tabview";

export function initializeServices(styleService: StyleService, mapService: MapService, coordService: CoordinatesService) {
    return async () => {
        await initializeLibrary();
        coordService.initialize();
        await styleService.initializeStyles();
        await mapService.initialize();
    }
}

@NgModule({
    declarations: [
        AppComponent,
        SearchPanelComponent,
        MapPanelComponent,
        InspectionPanelComponent,
        FeaturePanelComponent,
        SourceDataPanelComponent,
        PreferencesComponent,
        EditorComponent,
        ErdblickViewComponent,
        CoordinatesPanelComponent,
        FeatureSearchComponent,
        AlertDialogComponent,
        EnterSelectDirective,
        HighlightSearch,
        TreeTableFilterPatchDirective,
    ],
    bootstrap: [
        AppComponent
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
        FileUploadModule,
        CheckboxModule,
        InputTextModule,
        MenuModule,
        CardModule,
        ColorPickerModule,
        ListboxModule,
        MultiSelectModule,
        InputTextareaModule,
        FloatLabelModule,
        TabViewModule,
        InputTextareaModule,
        ButtonGroupModule,
        TabViewModule,
        BreadcrumbModule,
        TableModule
    ],
    providers: [
        {
            provide: APP_INITIALIZER,
            useFactory: initializeServices,
            deps: [StyleService, MapService, CoordinatesService],
            multi: true
        },
        MapService,
        MessageService,
        InfoMessageService,
        JumpTargetService,
        InspectionService,
        ParametersService,
        SidePanelService,
        FeatureSearchService,
        ClipboardService,
        provideHttpClient(withInterceptorsFromDi()),
    ]
})
export class AppModule {
}
