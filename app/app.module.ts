import {LocationPolicyService} from "./geolocation/location-policy.service";
import {LocationTermsDialogComponent} from "./geolocation/location-terms-dialog.component";
import {LocationAttributionComponent} from "./geolocation/location-attribution.component";
import {StyleDocumentEditorComponent} from "./mapstyle/style-document-editor.component";
import { provideHttpClient, withFetch } from "@angular/common/http";
import {
    inject,
    Injector,
    NgModule,
    provideAppInitializer
} from "@angular/core";
import { FormsModule, ReactiveFormsModule } from "@angular/forms";
import { BrowserModule } from '@angular/platform-browser';
import { BrowserAnimationsModule } from "@angular/platform-browser/animations";
import { provideAnimationsAsync } from "@angular/platform-browser/animations/async";
import { definePreset } from '@primeng/themes';
import Aura from "@primeng/themes/aura";
import { AccordionModule } from "primeng/accordion";
import { AnimateOnScroll } from "primeng/animateonscroll";
import { ConfirmationService, MessageService } from "primeng/api";
import { AutoCompleteModule } from 'primeng/autocomplete';
import { BadgeModule } from "primeng/badge";
import { BreadcrumbModule } from "primeng/breadcrumb";
import { ButtonModule } from "primeng/button";
import { ButtonGroupModule } from "primeng/buttongroup";
import { CardModule } from "primeng/card";
import { CheckboxModule } from "primeng/checkbox";
import { ChipModule } from "primeng/chip";
import { ColorPickerModule } from "primeng/colorpicker";
import { providePrimeNG } from "primeng/config";
import { ConfirmPopupModule } from "primeng/confirmpopup";
import { ContextMenuModule } from "primeng/contextmenu";
import { DialogModule } from "primeng/dialog";
import { DividerModule } from "primeng/divider";
import { DialogService, DynamicDialogModule } from "primeng/dynamicdialog";
import { FieldsetModule } from "primeng/fieldset";
import { FileUploadModule } from "primeng/fileupload";
import { FloatLabelModule } from "primeng/floatlabel";
import { IconFieldModule } from 'primeng/iconfield';
import { IftaLabelModule } from "primeng/iftalabel";
import { InputIconModule } from 'primeng/inputicon';
import { InputNumberModule } from "primeng/inputnumber";
import { InputTextModule } from "primeng/inputtext";
import { ListboxModule } from "primeng/listbox";
import { MenuModule } from "primeng/menu";
import { Menubar } from "primeng/menubar";
import { MessageModule } from "primeng/message";
import { MeterGroupModule } from "primeng/metergroup";
import { MultiSelectModule } from "primeng/multiselect";
import { PanelMenuModule } from "primeng/panelmenu";
import { PopoverModule } from "primeng/popover";
import { ProgressBarModule } from "primeng/progressbar";
import { ProgressSpinnerModule } from "primeng/progressspinner";
import { RadioButtonModule } from "primeng/radiobutton";
import { Ripple } from "primeng/ripple";
import { ScrollPanelModule } from "primeng/scrollpanel";
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { SliderModule } from "primeng/slider";
import { Splitter } from "primeng/splitter";
import { TableModule } from "primeng/table";
import { TabsModule } from "primeng/tabs";
import { Tag } from "primeng/tag";
import { Textarea } from "primeng/textarea";
import { ToastModule } from "primeng/toast";
import { ToggleButton } from "primeng/togglebutton";
import { ToggleSwitch } from "primeng/toggleswitch";
import { TooltipModule } from "primeng/tooltip";
import { TreeModule } from "primeng/tree";
import { TreeSelectModule } from "primeng/treeselect";
import { TreeTableModule } from "primeng/treetable";
import { McpActionService } from "./action/mcp-action.service";
import { OmnibarComponent } from "./omnibar/omnibar.component";
import { ViewerActionStatusComponent } from "./action/viewer-action-status.component";
import { WebMcpService } from "./action/web-mcp.service";
import { AppComponent } from './app.component';
import { MainBarComponent } from "./layout/app-mainbar.component";
import { AppRoutingModule } from './app-routing.module';
import { registerApplication } from "./application-registration";
import { AboutComponent } from "./config/about.component";
import { AdvancedPreferencesComponent } from "./preferences/advanced-preferences.component";
import { CacheResetComponent } from "./mapdata/cache-reset.component";
import { DatasourcesComponent } from "./mapdata/datasources.component";
import { KeyboardComponent } from "./keyboard/keyboard.component";
import { LegalInfoDialogComponent } from "./mapdata/legalinfo.component";
import { PreferencesComponent } from "./preferences/preferences.component";
import { SurveyComponent } from "./survey/survey.component";
import { AppConfigService } from "./config/appconfig.service";
import { CoordinatesLegalTermsDialogComponent } from "./coordinates/coordinates-legal-terms-dialog.component";
import { CoordinatesPolicyService } from "./coordinates/coordinates-policy.service";
import { CoordinatesPanelComponent } from "./coordinates/coordinates-panel.component";
import { CoordinatesService } from "./coordinates/coordinates.service";
import { DiagnosticsExportDialogComponent } from "./diagnostics/diagnostics-export.component";
import { DiagnosticsFacadeService } from "./diagnostics/diagnostics-facade.service";
import { DiagnosticsIndicatorComponent } from "./diagnostics/diagnostics-indicator.component";
import { DiagnosticsLogDialogComponent } from "./diagnostics/diagnostics-log.component";
import { DiagnosticsPerformanceDialogComponent } from "./diagnostics/diagnostics-perf.component";
import { DiagnosticsProgressComponent } from "./diagnostics/diagnostics-progress.component";
import { FeaturePanelComponent } from "./inspection/feature-panel.component";
import { HighlightSearch } from "./inspection/highlight.pipe";
import { HighlightRegion } from "./inspection/highlight-region.pipe";
import { InspectionComparisonDialogComponent } from "./inspection/inspection-comparison-dialog.component";
import { InspectionSelectionService } from "./inspection/inspection-selection.service";
import { InspectionContainerComponent } from "./inspection/inspection-container.component";
import { InspectionPanelDialogComponent } from "./inspection/inspection-dialog.component";
import { InspectionDialogsComponent } from "./inspection/inspection-dialogs.component";
import { InspectionPanelComponent } from "./inspection/inspection-panel.component";
import { InspectionTreeComponent } from "./inspection/inspection-tree.component";
import { SourceDataPanelComponent } from "./inspection/sourcedata-panel.component";
import { SourceDataLayerSelectionDialogComponent } from "./inspection/sourcedata-selection-dialog.component";
import { TreeTableFilterPatchDirective } from "./inspection/treetablefilter-patch.directive";
import { initializeLibrary } from "./integrations/wasm.adapter";
import { AppDialogComponent } from "./layout/app-dialog.component";
import { AppPanelComponent } from "./layout/app-panel.component";
import { AppSurfaceHeaderComponent } from "./layout/app-surface-header.component";
import { DockableLayoutComponent } from "./layout/dockable-layout.component";
import { MapDataService } from "./mapdata/mapdata.service";
import { MapTileStreamService } from "./mapdata/map-tile-stream.service";
import { MapPanelComponent } from "./mapdata/map-panel.component";
import { TileSubsetLayerRenderService } from "./mapview/deck/tile-subset-layer-render.service";
import { RightClickMenuService } from "./mapview/rightclickmenu.service";
import { MapViewComponent } from "./mapview/view.component";
import { MapViewContainerComponent } from "./mapview/view-container.component";
import { ErdblickViewUIComponent } from "./mapview/view-ui.component";
import { JumpTargetService } from "./navigation/jump.service";
import { FeatureSearchExportDialogComponent } from "./search/feature-search-export-dialog.component";
import { SearchComponent } from "./search/search.component";
import { SearchDialogsComponent } from "./search/search-dialogs.component";
import { SearchService } from "./search/search.service";
import { GeolocationService } from "./geolocation/geolocation.service";
import { SearchCompletionPopupComponent } from "./search/search-completion-popup.component";
import { SearchStyleColorComponent } from "./search/search-style-color.component";
import { SearchStyleRuleEditorComponent } from "./search/search-style-rule-editor.component";
import { SearchStyleSaveDialogComponent } from "./search/search-style-save-dialog.component";
import { SimfilExpressionInputComponent } from "./search/simfil-expression-input.component";
import { AppConfirmPopupComponent } from "./alert/app-confirm-popup.component";
import { ClipboardService } from "./clipboard/clipboard.service";
import { EditorComponent } from "./editor/editor.component";
import { EditorService } from "./editor/editor.service";
import { InfoMessageService } from "./diagnostics/info.service";
import { OnEnterClickDirective } from "./keyboard/keyboard.service";
import { PresentationStateBridgeService } from "./action/presentation-state-bridge.service";
import { AppStateService } from "./appstate/appstate.service";
import { AppUrlStateService } from "./appstate/appstate-url.service";
import { MapPresetService } from "./mapstyle/map-preset.service";
import { StyleComponent } from "./mapstyle/mapstyle.component";
import { MapStyleService } from "./mapstyle/mapstyle.service";

/** PrimeNG theme preset used across the application. */
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

/** Updates the pre-bootstrap global loading spinner shown before Angular starts. */
const updateGlobalSpinner = (message: string) => {
    const messageEl = document.getElementById('global-spinner-message');
    if (messageEl) {
        messageEl.textContent = message;
    }
    const detailsEl = document.getElementById('global-spinner-details');
    if (detailsEl) {
        const line = document.createElement('div');
        line.className = 'spinner-line';
        line.textContent = message;
        detailsEl.appendChild(line);
    }
};

/** App initializer that loads config and then brings up the WASM core, styles, map data, and search state in order. */
export const initializeServices = () => {
    registerApplication(inject(Injector));
    const configService = inject(AppConfigService);
    const stateService = inject(AppStateService);
    const styleService = inject(MapStyleService);
    const mapPresetService = inject(MapPresetService);
    const tileStream = inject(MapTileStreamService);
    const inspectionSelection = inject(InspectionSelectionService);
    const coordService = inject(CoordinatesService);
    const coordinatesPolicy = inject(CoordinatesPolicyService);
    const locationPolicy = inject(LocationPolicyService);
    const subsetRenderService = inject(TileSubsetLayerRenderService);
    const presentationBridge = inject(PresentationStateBridgeService);
    const viewerActions = inject(McpActionService);
    const webMcp = inject(WebMcpService);
    const featureSearch = inject(SearchService);
    const diagnostics = inject(DiagnosticsFacadeService);
    inject(GeolocationService);
    const urlState = inject(AppUrlStateService);
    const jumps = inject(JumpTargetService);

    return (async () => {
        updateGlobalSpinner('Loading app config');
        await configService.load();
        stateService.seedConfigDefaultState(
            configService.snapshot.state,
            configService.snapshot.configStateHash
        );
        updateGlobalSpinner('Initializing core library');
        await initializeLibrary();
        updateGlobalSpinner('Loading render worker');
        await subsetRenderService.preloadWorkerSource();
        stateService.initializePersistence();
        coordinatesPolicy.initialize();
        locationPolicy.initialize();
        updateGlobalSpinner('Initializing coordinates');
        coordService.initialize();
        updateGlobalSpinner('Loading styles');
        await styleService.initializeStyles();
        mapPresetService.initialize();
        updateGlobalSpinner('Initializing map data');
        await tileStream.initialize();
        jumps.initialize();
        inspectionSelection.initialize();
        featureSearch.initialize();
        diagnostics.initialize();
        presentationBridge.initialize();
        viewerActions.initialize();
        webMcp.initialize();
    })();
}

@NgModule({
    declarations: [
        AppComponent,
        OmnibarComponent,
        MapPanelComponent,
        InspectionPanelComponent,
        FeaturePanelComponent,
        SourceDataPanelComponent,
        PreferencesComponent,
        EditorComponent,
        CoordinatesPanelComponent,
        LocationTermsDialogComponent,
        LocationAttributionComponent,
        SearchComponent,
        SearchStyleColorComponent,
        SearchStyleRuleEditorComponent,
        SearchDialogsComponent,
        FeatureSearchExportDialogComponent,
        DatasourcesComponent,
        OnEnterClickDirective,
        HighlightSearch,
        HighlightRegion,
        TreeTableFilterPatchDirective,
        SourceDataLayerSelectionDialogComponent,
        LegalInfoDialogComponent,
        AboutComponent,
        KeyboardComponent,
        MainBarComponent,
        ErdblickViewUIComponent,
        StyleComponent,
        MapViewContainerComponent,
        MapViewComponent,
        InspectionContainerComponent,
        InspectionTreeComponent,
        DockableLayoutComponent,
        InspectionPanelDialogComponent,
        InspectionDialogsComponent,
        InspectionComparisonDialogComponent,
        SurveyComponent,
        DiagnosticsIndicatorComponent,
        ViewerActionStatusComponent,
        DiagnosticsProgressComponent,
        DiagnosticsPerformanceDialogComponent,
        DiagnosticsLogDialogComponent,
        DiagnosticsExportDialogComponent,
        AdvancedPreferencesComponent,
        CoordinatesLegalTermsDialogComponent
    ],
    bootstrap: [
        AppComponent
    ],
    imports: [
        StyleDocumentEditorComponent,
        BrowserModule,
        BrowserAnimationsModule,
        AnimateOnScroll,
        AppRoutingModule,
        CacheResetComponent,
        AppDialogComponent,
        AppPanelComponent,
        AppSurfaceHeaderComponent,
        AppConfirmPopupComponent,
        SearchStyleSaveDialogComponent,
        SearchCompletionPopupComponent,
        SimfilExpressionInputComponent,
        DialogModule,
        DynamicDialogModule,
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
        TreeSelectModule,
        FloatLabelModule,
        IftaLabelModule,
        MessageModule,
        Textarea,
        ButtonGroupModule,
        BreadcrumbModule,
        TableModule,
        SelectModule,
        AutoCompleteModule,
        ReactiveFormsModule,
        ProgressBarModule,
        MeterGroupModule,
        ButtonModule,
        TooltipModule,
        ProgressSpinnerModule,
        ContextMenuModule,
        ConfirmPopupModule,
        IconFieldModule,
        InputIconModule,
        PopoverModule,
        RadioButtonModule,
        SelectButtonModule,
        ChipModule,
        Splitter,
        ToggleSwitch,
        ToggleButton,
        Menubar,
        Ripple,
        Tag
    ],
    providers: [
        provideAppInitializer(initializeServices),
        MapDataService,
        MapTileStreamService,
        InspectionSelectionService,
        MessageService,
        ConfirmationService,
        InfoMessageService,
        JumpTargetService,
        AppStateService,
        SearchService,
        ClipboardService,
        EditorService,
        RightClickMenuService,
        DialogService,
        provideHttpClient(withFetch()),
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
/** Root Angular module for the full erdblick application. */
export class AppModule {
}
