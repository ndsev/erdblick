export const DEFAULT_EM_WIDTH = 30;

export const DEFAULT_EM_HEIGHT = 40;

export const DEFAULT_DOCKED_EM_HEIGHT = 20;

export const ABOUT_DIALOG_LAYOUT_ID = "about-dialog";

export const LEGAL_INFO_DIALOG_LAYOUT_ID = "legal-info-dialog";

export const PREFERENCES_DIALOG_LAYOUT_ID = "preferences-dialog";

export const KEYBOARD_DIALOG_LAYOUT_ID = "keyboard-dialog";

export const DATASOURCES_EDITOR_DIALOG_LAYOUT_ID = "datasources-editor-dialog";

export const ADVANCED_PREFERENCES_DIALOG_LAYOUT_ID = "advanced-preferences-dialog";

export const DIAGNOSTICS_PERFORMANCE_DIALOG_LAYOUT_ID = "diagnostics-performance";

export const DIAGNOSTICS_LOG_DIALOG_LAYOUT_ID = "diagnostics-log";

export const DIAGNOSTICS_EXPORT_DIALOG_LAYOUT_ID = "diagnostics-export";

export const CACHE_RESET_DIALOG_LAYOUT_ID = "cache-reset-dialog";

export const STYLES_DIALOG_LAYOUT_ID = "styles-dialog";

export const STYLE_EDITOR_DIALOG_LAYOUT_ID = "style-editor-dialog";

export const STYLE_PRESET_EDITOR_DIALOG_LAYOUT_ID = "style-preset-editor-dialog";

export const FEATURE_SEARCH_DIALOG_LAYOUT_ID = "feature-search";

export const FEATURE_SEARCH_EXPORT_DIALOG_LAYOUT_ID = "feature-search-export";

export const SOURCE_DATA_SELECTION_DIALOG_LAYOUT_ID = "source-data-selection-dialog";

export const INSPECTION_DOCK_TAB_ID = "inspection";

export const SEARCH_DOCK_TAB_ID = "search";

/** Persisted top-left dialog position in viewport pixels. */
export interface AppDialogPosition {
    left: number;
    top: number;
}

/** Persisted dialog size in viewport pixels. */
export interface AppDialogSize {
    width: number;
    height: number;
}

/** Generic persisted dialog layout record. */
export interface AppDialogLayout {
    position: AppDialogPosition;
    size: AppDialogSize;
    open?: boolean;
    docked?: boolean;
    dockTab?: string;
    dockOrder?: number;
    panelSize?: AppDialogSize;
    panelCollapsed?: boolean;
    panelExpanded?: boolean;
}
