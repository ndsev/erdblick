import {inject, NgModule, provideAppInitializer} from '@angular/core';
import {BrowserModule} from '@angular/platform-browser';
import {AppRoutingModule} from './app-routing.module';
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
import {OverlayPanelModule} from "primeng/overlaypanel";
import {DividerModule} from "primeng/divider";
import {PanelMenuModule} from "primeng/panelmenu";
import {TreeTableModule} from "primeng/treetable";
import {ToastModule} from "primeng/toast";
import {MessageService} from "primeng/api";
import {InputNumberModule} from "primeng/inputnumber";
import {FieldsetModule} from "primeng/fieldset";
import {AlertDialogComponent, InfoMessageService} from "./info.service";
import {SearchPanelComponent} from "./search.panel.component";
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
import {HighlightRegion} from "./highlight.region.pipe";
import {TreeTableFilterPatchDirective} from "./treetablefilter-patch.directive";
import {Textarea} from "primeng/textarea";
import {FloatLabelModule} from "primeng/floatlabel";
import {TabsModule} from "primeng/tabs";
import {OnEnterClickDirective} from "./keyboard.service";
import {SelectModule} from 'primeng/select';
import {AutoCompleteModule} from 'primeng/autocomplete';
import {
    ArrayTypeComponent,
    DatasourcesComponent,
    MultiSchemaTypeComponent,
    ObjectTypeComponent
} from "./datasources.component";
import {EditorService} from "./editor.service";
import {FormlyFieldConfig, FormlyModule} from "@ngx-formly/core";
import {ReactiveFormsModule} from '@angular/forms';
import {FormlyPrimeNGModule} from "@ngx-formly/primeng";
import {DataSourcesService} from "./datasources.service";
import {ProgressSpinnerModule} from "primeng/progressspinner";
import {ProgressBarModule} from "primeng/progressbar";
import {ButtonModule} from "primeng/button";
import {TooltipModule} from "primeng/tooltip";
import {StatsDialogComponent} from "./stats.component";
import {SourceDataLayerSelectionDialogComponent} from "./sourcedataselection.dialog.component";
import {ContextMenuModule} from "primeng/contextmenu";
import {RightClickMenuService} from "./rightclickmenu.service";
import {LegalInfoDialogComponent} from "./legalinfo.component";
import {IconFieldModule} from 'primeng/iconfield';
import {InputIconModule} from 'primeng/inputicon';
import {PopoverModule} from "primeng/popover";
import {provideAnimationsAsync} from "@angular/platform-browser/animations/async";
import {providePrimeNG} from "primeng/config";
import {definePreset} from '@primeng/themes';
import Aura from "@primeng/themes/aura";
import {ErdblickViewUIComponent} from "./view.ui.component";
import {ViewService} from "./view.service";
import {CameraService} from "./camera.service";
import {MarkerService} from "./marker.service";
import {ViewStateService} from "./view.state.service";
import {SelectButtonModule} from 'primeng/selectbutton';

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


export function minItemsValidationMessage(error: any, field: FormlyFieldConfig) {
    return `should NOT have fewer than ${field.props?.['minItems']} items`;
}

export function maxItemsValidationMessage(error: any, field: FormlyFieldConfig) {
    return `should NOT have more than ${field.props?.['maxItems']} items`;
}

export function minLengthValidationMessage(error: any, field: FormlyFieldConfig) {
    return `should NOT be shorter than ${field.props?.minLength} characters`;
}

export function maxLengthValidationMessage(error: any, field: FormlyFieldConfig) {
    return `should NOT be longer than ${field.props?.maxLength} characters`;
}

export function minValidationMessage(error: any, field: FormlyFieldConfig) {
    return `should be >= ${field.props?.min}`;
}

export function maxValidationMessage(error: any, field: FormlyFieldConfig) {
    return `should be <= ${field.props?.max}`;
}

export function multipleOfValidationMessage(error: any, field: FormlyFieldConfig) {
    return `should be multiple of ${field.props?.step}`;
}

export function exclusiveMinimumValidationMessage(error: any, field: FormlyFieldConfig) {
    return `should be > ${field.props?.step}`;
}

export function exclusiveMaximumValidationMessage(error: any, field: FormlyFieldConfig) {
    return `should be < ${field.props?.step}`;
}

export function constValidationMessage(error: any, field: FormlyFieldConfig) {
    return `should be equal to constant "${field.props?.['const']}"`;
}

export function typeValidationMessage({ schemaType }: any) {
    return `should be "${schemaType[0]}".`;
}

export const initializeServices = () => {
    const styleService = inject(StyleService);
    const mapService = inject(MapService);
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
        ErdblickViewComponent,
        CoordinatesPanelComponent,
        FeatureSearchComponent,
        AlertDialogComponent,
        DatasourcesComponent,
        OnEnterClickDirective,
        ArrayTypeComponent,
        ObjectTypeComponent,
        MultiSchemaTypeComponent,
        HighlightSearch,
        HighlightRegion,
        TreeTableFilterPatchDirective,
        StatsDialogComponent,
        SourceDataLayerSelectionDialogComponent,
        LegalInfoDialogComponent,
        ErdblickViewUIComponent
    ],
    bootstrap: [
        AppComponent
    ],
    imports: [
        FormlyModule.forRoot({
            validationMessages: [
                {name: 'required', message: 'This field is required'},
                {name: 'type', message: typeValidationMessage},
                {name: 'minLength', message: minLengthValidationMessage},
                {name: 'maxLength', message: maxLengthValidationMessage},
                {name: 'min', message: minValidationMessage},
                {name: 'max', message: maxValidationMessage},
                {name: 'multipleOf', message: multipleOfValidationMessage},
                {name: 'exclusiveMinimum', message: exclusiveMinimumValidationMessage},
                {name: 'exclusiveMaximum', message: exclusiveMaximumValidationMessage},
                {name: 'minItems', message: minItemsValidationMessage},
                {name: 'maxItems', message: maxItemsValidationMessage},
                {name: 'uniqueItems', message: 'should NOT have duplicate items'},
                {name: 'const', message: constValidationMessage},
                {name: 'enum', message: `must be equal to one of the allowed values`},
            ],
            types: [
                {name: 'array', component: ArrayTypeComponent},
                {name: 'object', component: ObjectTypeComponent},
                {name: 'multischema', component: MultiSchemaTypeComponent}
            ],
        }),
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
        OverlayPanelModule,
        DividerModule,
        TabsModule,
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
        FloatLabelModule,
        MessageModule,
        Textarea,
        ButtonGroupModule,
        BreadcrumbModule,
        TableModule,
        SelectModule,
        AutoCompleteModule,
        ReactiveFormsModule,
        FormlyPrimeNGModule,
        ProgressBarModule,
        ButtonModule,
        TooltipModule,
        ProgressSpinnerModule,
        ContextMenuModule,
        IconFieldModule,
        InputIconModule,
        PopoverModule,
        SelectButtonModule
    ],
    providers: [
        provideAppInitializer(initializeServices),
        MapService,
        MessageService,
        InfoMessageService,
        JumpTargetService,
        InspectionService,
        ParametersService,
        SidePanelService,
        FeatureSearchService,
        ClipboardService,
        EditorService,
        DataSourcesService,
        RightClickMenuService,
        ViewStateService,
        CameraService,
        ViewService,
        MarkerService,
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
