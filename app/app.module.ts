import {inject, NgModule, provideAppInitializer} from '@angular/core';
import {BrowserModule} from '@angular/platform-browser';
import {AppRoutingModule} from './app.routing.module';
import {AppComponent} from './app.component';
import {provideHttpClient} from "@angular/common/http";
import {SpeedDialModule} from "primeng/speeddial";
import {DialogModule} from "primeng/dialog";
import {BrowserAnimationsModule} from "@angular/platform-browser/animations";
import {AnimateOnScroll} from "primeng/animateonscroll";
import {FormsModule} from "@angular/forms";
import {ScrollPanelModule} from "primeng/scrollpanel";
import {BadgeModule} from "primeng/badge";
import {TreeModule} from "primeng/tree";
import {MessageModule} from "primeng/message";
import {AccordionModule} from "primeng/accordion";
import {DividerModule} from "primeng/divider";
import {PanelMenuModule} from "primeng/panelmenu";
import {TreeTableModule} from "primeng/treetable";
import {ToastModule} from "primeng/toast";
import {MessageService} from "primeng/api";
import {InputNumberModule} from "primeng/inputnumber";
import {FieldsetModule} from "primeng/fieldset";
import {InfoMessageService} from "./shared/info.service";
import {SearchPanelComponent} from "./search/search.panel.component";
import {JumpTargetService} from "./search/jump.service";
import {MapDataService} from "./mapdata/map.service";
import {SliderModule} from "primeng/slider";
import {StyleService} from "./styledata/style.service";
import {FeatureSearchComponent} from "./search/feature.search.component";
import {MapPanelComponent} from "./mapdata/map.panel.component";
import {InspectionPanelComponent} from "./inspection/inspection.panel.component";
import {FeaturePanelComponent} from "./inspection/feature.panel.component";
import {SourceDataPanelComponent} from "./inspection/sourcedata.panel.component";
import {AppStateService} from "./shared/appstate.service";
import {PreferencesComponent} from "./auxiliaries/preferences.component";
import {FileUploadModule} from "primeng/fileupload";
import {EditorComponent} from "./shared/editor.component";
import {CoordinatesPanelComponent} from "./coords/coordinates.panel.component";
import {initializeLibrary} from "./integrations/wasm";
import {CheckboxModule} from "primeng/checkbox";
import {InputTextModule} from "primeng/inputtext";
import {MenuModule} from "primeng/menu";
import {CardModule} from "primeng/card";
import {CoordinatesService} from "./coords/coordinates.service";
import {ColorPickerModule} from "primeng/colorpicker";
import {ListboxModule} from "primeng/listbox";
import {FeatureSearchService} from "./search/feature.search.service";
import {ClipboardService} from "./shared/clipboard.service";
import {MultiSelectModule} from "primeng/multiselect";
import {ButtonGroupModule} from "primeng/buttongroup";
import {BreadcrumbModule} from "primeng/breadcrumb";
import {TableModule} from "primeng/table";
import {HighlightSearch} from "./inspection/highlight.pipe";
import {HighlightRegion} from "./inspection/highlight.region.pipe";
import {TreeTableFilterPatchDirective} from "./inspection/treetablefilter-patch.directive";
import {Textarea} from "primeng/textarea";
import {FloatLabelModule} from "primeng/floatlabel";
import {TabsModule} from "primeng/tabs";
import {OnEnterClickDirective} from "./shared/keyboard.service";
import {SelectModule} from 'primeng/select';
import {AutoCompleteModule} from 'primeng/autocomplete';
import {DatasourcesComponent} from "./auxiliaries/datasources.component";
import {EditorService} from "./shared/editor.service";
import {ReactiveFormsModule} from '@angular/forms';
import {ProgressSpinnerModule} from "primeng/progressspinner";
import {ProgressBarModule} from "primeng/progressbar";
import {ButtonModule} from "primeng/button";
import {TooltipModule} from "primeng/tooltip";
import {StatsDialogComponent} from "./auxiliaries/stats.component";
import {SourceDataLayerSelectionDialogComponent} from "./inspection/sourcedataselection.dialog.component";
import {ContextMenuModule} from "primeng/contextmenu";
import {RightClickMenuService} from "./mapview/rightclickmenu.service";
import {LegalInfoDialogComponent} from "./auxiliaries/legalinfo.component";
import {IconFieldModule} from 'primeng/iconfield';
import {InputIconModule} from 'primeng/inputicon';
import {PopoverModule} from "primeng/popover";
import {provideAnimationsAsync} from "@angular/platform-browser/animations/async";
import {providePrimeNG} from "primeng/config";
import {definePreset} from '@primeng/themes';
import Aura from "@primeng/themes/aura";
import {ErdblickViewUIComponent} from "./mapview/view.ui.component";
import {SelectButtonModule} from 'primeng/selectbutton';
import {ChipModule} from "primeng/chip";
import {StyleComponent} from "./styledata/style.component";
import {MapViewContainerComponent} from "./mapview/view.container.component";
import {MapViewComponent} from "./mapview/view.component";
import {Splitter} from "primeng/splitter";
import {InspectionContainerComponent} from "./inspection/inspection.container.component";
import {InspectionTreeComponent} from "./inspection/inspection.tree.component";
import {ToggleSwitch} from "primeng/toggleswitch";
import {ToggleButton} from "primeng/togglebutton";
import {SurveyComponent} from "./auxiliaries/survey.component";

export const ErdblickTheme = definePreset(Aura, {
    semantic: {
        primary: {
            50: '{blue.50}',
            100: '{blue.100}',
            200: '{blue.200}',
            300: '{blue.300}',
            400: '{blue.400}',
            500: '{blue.500}',
            600: '{blue.600}',
            700: '{blue.700}',
            800: '{blue.800}',
            900: '{blue.900}',
            950: '{blue.950}'
        }
    }
});

export const initializeServices = () => {
    const styleService = inject(StyleService);
    const mapService = inject(MapDataService);
    const coordService = inject(CoordinatesService);

    return (async () => {
        await initializeLibrary();
        coordService.initialize();
        await styleService.initializeStyles();
        await mapService.initialize();
    })();
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
        CoordinatesPanelComponent,
        FeatureSearchComponent,
        DatasourcesComponent,
        OnEnterClickDirective,
        HighlightSearch,
        HighlightRegion,
        TreeTableFilterPatchDirective,
        StatsDialogComponent,
        SourceDataLayerSelectionDialogComponent,
        LegalInfoDialogComponent,
        ErdblickViewUIComponent,
        StyleComponent,
        MapViewContainerComponent,
        MapViewComponent,
        InspectionContainerComponent,
        InspectionTreeComponent,
        SurveyComponent
    ],
    bootstrap: [
        AppComponent
    ],
    imports: [
        BrowserModule,
        BrowserAnimationsModule,
        AnimateOnScroll,
        AppRoutingModule,
        SpeedDialModule,
        DialogModule,
        FormsModule,
        ScrollPanelModule,
        BadgeModule,
        TreeModule,
        AccordionModule,
        DividerModule,
        TabsModule,
        PanelMenuModule,
        TreeTableModule,
        ToastModule,
        InputNumberModule,
        FieldsetModule,
        SliderModule,
        FileUploadModule,
        CheckboxModule,
        InputTextModule,
        MenuModule,
        CardModule,
        ColorPickerModule,
        ListboxModule,
        MultiSelectModule,
        FloatLabelModule,
        MessageModule,
        Textarea,
        ButtonGroupModule,
        BreadcrumbModule,
        TableModule,
        SelectModule,
        AutoCompleteModule,
        ReactiveFormsModule,
        ProgressBarModule,
        ButtonModule,
        TooltipModule,
        ProgressSpinnerModule,
        ContextMenuModule,
        IconFieldModule,
        InputIconModule,
        PopoverModule,
        SelectButtonModule,
        ChipModule,
        Splitter,
        ToggleSwitch,
        ToggleButton
    ],
    providers: [
        provideAppInitializer(initializeServices),
        MapDataService,
        MessageService,
        InfoMessageService,
        JumpTargetService,
        AppStateService,
        FeatureSearchService,
        ClipboardService,
        EditorService,
        RightClickMenuService,
        provideHttpClient(),
        provideAnimationsAsync(),
        providePrimeNG({
            ripple: true,
            theme: {
                preset: ErdblickTheme,
                options: {
                    darkModeSelector: '.erdblick-dark'
                }
            }
        })
    ]
})
export class AppModule {
}
