import { provideHttpClient, withFetch } from "@angular/common/http";
import { inject, NgModule, provideAppInitializer } from '@angular/core';
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
import { AppActionService } from "./actions/app-action.service";
import { applicationControls } from "./actions/application-controls";
import { ViewerActionStatusComponent } from "./actions/viewer-action-status.component";
import { applicationActions as declaredActions } from "./actions/viewer-action.contract";
import { ViewerActionService } from "./actions/viewer-action.service";
import { ViewerUiService } from "./actions/viewer-ui.service";
import { WebMcpService } from "./actions/web-mcp.service";
import { AppComponent } from './app.component';
import { DockableLayoutComponent } from "./app.dockable.layout.component";
import { MainBarComponent } from "./app.mainbar.component";
import { AppRoutingModule } from './app.routing.module';
import { AboutComponent } from "./auxiliaries/about.component";
import { AdvancedPreferencesComponent } from "./auxiliaries/advanced-preferences.component";
import { CacheResetComponent } from "./auxiliaries/cache-reset.component";
import { DatasourcesComponent } from "./auxiliaries/datasources.component";
import { KeyboardComponent } from "./auxiliaries/keyboard.component";
import { LegalInfoDialogComponent } from "./auxiliaries/legalinfo.component";
import { PreferencesComponent } from "./auxiliaries/preferences.component";
import { SurveyComponent } from "./auxiliaries/survey.component";
import { CoordinatesLegalTermsDialogComponent } from "./coords/coordinates-legal-terms-dialog.component";
import { CoordinatesPolicyService } from "./coords/coordinates-policy.service";
import { CoordinatesPanelComponent } from "./coords/coordinates.panel.component";
import { CoordinatesService } from "./coords/coordinates.service";
import { DiagnosticsExportDialogComponent } from "./diagnostics/diagnostics.export.component";
import { DiagnosticsFacadeService } from "./diagnostics/diagnostics.facade.service";
import { DiagnosticsIndicatorComponent } from "./diagnostics/diagnostics.indicator.component";
import { DiagnosticsLogDialogComponent } from "./diagnostics/diagnostics.log.component";
import { DiagnosticsPerformanceDialogComponent } from "./diagnostics/diagnostics.perf.component";
import { DiagnosticsProgressComponent } from "./diagnostics/diagnostics.progress.component";
import { FeaturePanelComponent } from "./inspection/feature.panel.component";
import { HighlightSearch } from "./inspection/highlight.pipe";
import { HighlightRegion } from "./inspection/highlight.region.pipe";
import { InspectionComparisonDialogComponent } from "./inspection/inspection-comparison.dialog.component";
import { InspectionSelectionService } from "./inspection/inspection-selection.service";
import { InspectionStateService } from "./inspection/inspection-state.service";
import { InspectionContainerComponent } from "./inspection/inspection.container.component";
import { InspectionPanelDialogComponent } from "./inspection/inspection.dialog.component";
import { InspectionDialogsComponent } from "./inspection/inspection.dialogs.component";
import { InspectionPanelComponent } from "./inspection/inspection.panel.component";
import { InspectionTreeComponent } from "./inspection/inspection.tree.component";
import { SourceDataPanelComponent } from "./inspection/sourcedata.panel.component";
import { SourceDataLayerSelectionDialogComponent } from "./inspection/sourcedata.selection.dialog.component";
import { TreeTableFilterPatchDirective } from "./inspection/treetablefilter-patch.directive";
import { initializeLibrary } from "./integrations/wasm";
import { ConnectionPreferencesService } from "./mapdata/connection-preferences.service";
import { MapInfoService } from "./mapdata/map-info.service";
import { MapLayerStateService } from "./mapdata/map-layer-state.service";
import { MapTileStreamService } from "./mapdata/map-tile-stream.service";
import { MapPanelComponent } from "./mapdata/map.panel.component";
import { TileSubsetLayerRenderService } from "./mapview/deck/tile-subset-layer-render.service";
import { MapViewStateService } from "./mapview/map-view-state.service";
import { MapViewService } from "./mapview/map-view.service";
import { RenderPreferencesService } from "./mapview/render-preferences.service";
import { RightClickMenuService } from "./mapview/rightclickmenu.service";
import { MapViewComponent } from "./mapview/view.component";
import { MapViewContainerComponent } from "./mapview/view.container.component";
import { ErdblickViewUIComponent } from "./mapview/view.ui.component";
import { ExternalViewerService } from "./search/external-viewer.service";
import { FeatureSearchExportDialogComponent } from "./search/feature-search-export.dialog.component";
import { FeatureSearchComponent } from "./search/feature.search.component";
import { FeatureSearchDialogsComponent } from "./search/feature.search.dialogs.component";
import { FeatureSearchService } from "./search/feature.search.service";
import { JumpTargetService } from "./search/jump.service";
import { LocationNavigationService } from "./search/location-navigation.service";
import { LocationSearchService } from "./search/location.search.service";
import { SearchCompletionPopupComponent } from "./search/search-completion-popup.component";
import { SearchStyleColorComponent } from "./search/search-style-color.component";
import { SearchStyleRuleEditorComponent } from "./search/search-style-rule-editor.component";
import { SearchStyleSaveDialogComponent } from "./search/search-style-save.dialog.component";
import { SearchPanelComponent } from "./search/search.panel.component";
import { SimfilExpressionInputComponent } from "./search/simfil-expression-input.component";
import { AppConfigService } from "./shared/app-config.service";
import { AppConfirmPopupComponent } from "./shared/app-confirm-popup.component";
import { AppDialogComponent } from "./shared/app-dialog.component";
import { AppLayoutService } from "./shared/app-layout.service";
import { AppPanelComponent } from "./shared/app-panel.component";
import { AppSurfaceHeaderComponent } from "./shared/app-surface-header.component";
import { AppUrlStateService } from "./shared/app-url-state.service";
import { AppStateService } from "./shared/appstate.service";
import { ClipboardService } from "./shared/clipboard.service";
import { EditorComponent } from "./shared/editor.component";
import { EditorService } from "./shared/editor.service";
import { InfoMessageService } from "./shared/info.service";
import { OnEnterClickDirective } from "./shared/keyboard.service";
import { PresentationStateBridgeService } from "./shared/presentation-state-bridge.service";
import { MapPresetService } from "./styledata/map-preset.service";
import { StyleComponent } from "./styledata/style.component";
import { StyleService } from "./styledata/style.service";

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
    const configService = inject(AppConfigService);
    const stateService = inject(AppStateService);
    const styleService = inject(StyleService);
    const mapPresetService = inject(MapPresetService);
    const tileStream = inject(MapTileStreamService);
    const inspectionSelection = inject(InspectionSelectionService);
    const coordService = inject(CoordinatesService);
    const coordinatesPolicy = inject(CoordinatesPolicyService);
    const subsetRenderService = inject(TileSubsetLayerRenderService);
    const presentationBridge = inject(PresentationStateBridgeService);
    const viewerActions = inject(ViewerActionService);
    const webMcp = inject(WebMcpService);
    const featureSearch = inject(FeatureSearchService);
    const diagnostics = inject(DiagnosticsFacadeService);
    inject(LocationSearchService);
    const urlState = inject(AppUrlStateService);
    // Resolve every durable-state owner before config/storage/URL hydration begins.
    inject(AppLayoutService);
    inject(MapViewStateService);
    inject(MapLayerStateService);
    inject(InspectionStateService);
    inject(RenderPreferencesService);
    inject(ConnectionPreferencesService);
    stateService.sealRegistration();

    // Every public declaration must be bound by its actual owner before either MCP
    // adapter advertises the build contract. Late registration is rejected.
    const actions = inject(AppActionService);
    const jumps = inject(JumpTargetService);
    for (const owner of [
        configService, styleService, inspectionSelection, featureSearch, diagnostics, coordService, urlState,
        inject(MapViewService), inject(MapViewStateService), inject(MapInfoService),
        inject(InspectionStateService), inject(RenderPreferencesService), inject(ConnectionPreferencesService),
        inject(LocationNavigationService), inject(ViewerUiService), jumps, inject(ExternalViewerService)
    ]) owner.registerActions(actions);
    actions.sealRegistration(Object.values(declaredActions), Object.values(applicationControls));

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
        SearchPanelComponent,
        MapPanelComponent,
        InspectionPanelComponent,
        FeaturePanelComponent,
        SourceDataPanelComponent,
        PreferencesComponent,
        EditorComponent,
        CoordinatesPanelComponent,
        FeatureSearchComponent,
        SearchStyleColorComponent,
        SearchStyleRuleEditorComponent,
        FeatureSearchDialogsComponent,
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
        MapInfoService,
        MapTileStreamService,
        InspectionSelectionService,
        MessageService,
        ConfirmationService,
        InfoMessageService,
        JumpTargetService,
        AppStateService,
        FeatureSearchService,
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
