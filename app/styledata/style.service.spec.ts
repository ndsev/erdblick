import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {of, BehaviorSubject, Subject} from 'rxjs';

import {StyleService} from './style.service';

class AppStateServiceStub {
    ready = new BehaviorSubject<boolean>(true);
    private visibility = new Map<string, boolean>();

    getStyleVisibility(styleId: string, fallback: boolean = true): boolean {
        return this.visibility.has(styleId) ? this.visibility.get(styleId)! : fallback;
    }

    setStyleVisibility(styleId: string, visible: boolean): void {
        this.visibility.set(styleId, visible);
    }
}

class HttpClientStub {
    get = vi.fn();
}

class InfoMessageServiceStub {
    showError = vi.fn();
    showSuccess = vi.fn();
}

const createService = () => {
    const httpClient = new HttpClientStub();
    const stateService = new AppStateServiceStub();
    const infoService = new InfoMessageServiceStub();
    const service = new StyleService(httpClient as any, stateService as any, infoService as any);
    return {service, httpClient, stateService, infoService};
};

describe('StyleService', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('initializes builtin styles from config.json and YAML sources', async () => {
        const {service, httpClient, stateService} = createService();

        const config = {
            styles: [
                {id: 's1', url: 'base.yaml'},
            ],
        };

        httpClient.get.mockImplementation((url: string, options: any) => {
            if (url === 'config.json') {
                return of(config);
            }
            if (url === 'bundle/styles/base.yaml') {
                return of('name: TestStyle');
            }
            throw new Error(`Unexpected URL ${url}`);
        });

        const featureLayerStyleStub = {
            name: () => 'TestStyle',
            defaultEnabled: () => true,
            delete: vi.fn(),
        } as any;
        const parseSpy = vi.spyOn(service as any, 'parseWasmStyle').mockReturnValue([featureLayerStyleStub, []]);
        const reapplySpy = vi.spyOn(service, 'reapplyStyles');

        await service.initializeStyles();

        expect(httpClient.get).toHaveBeenCalledWith('config.json', {responseType: 'json'});
        expect(parseSpy).toHaveBeenCalled();
        expect(service.styleUrls).toEqual([{id: 's1', url: 'bundle/styles/base.yaml'}]);
        expect(service.styles.size).toBe(1);
        const style = service.styles.get('TestStyle')!;
        expect(style.id).toBe('TestStyle');
        expect(style.imported).toBe(false);
        expect(style.visible).toBe(stateService.getStyleVisibility('TestStyle', true));
        expect(service.builtinStylesCount).toBe(1);
        expect(reapplySpy).toHaveBeenCalledWith(['TestStyle']);
    });

    it('handles missing styles configuration without throwing and without populating styles', async () => {
        const {service, httpClient} = createService();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        httpClient.get.mockReturnValue(of({}));

        await service.initializeStyles();

        expect(service.styleUrls).toEqual([]);
        expect(service.styles.size).toBe(0);
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
    });

    it('persists and reloads imported styles via localStorage', () => {
        const {service} = createService();

        const featureLayerStyleStub = {
            name: () => 'ImportedStyle',
            defaultEnabled: () => true,
            delete: vi.fn(),
        } as any;
        service.styles.set('ImportedStyle', {
            id: 'ImportedStyle',
            modified: false,
            imported: true,
            source: 'name: ImportedStyle',
            featureLayerStyle: featureLayerStyleStub,
            options: [],
            shortId: 'IMP1',
            visible: true,
            url: '',
        } as any);

        service.saveImportedStyles();

        const stored = localStorage.getItem('importedStyleData');
        expect(stored).not.toBeNull();

        // Clear in-memory state and reload from storage.
        service.styles.clear();
        service.importedStylesCount = 0;
        const initSpy = vi.spyOn(service as any, 'initializeStyle').mockReturnValue('ImportedStyle');

        service.loadImportedStyles();

        expect(initSpy).toHaveBeenCalled();
        expect(service.importedStylesCount).toBe(1);
    });

    it('imports a YAML file as an imported style and re-applies it', async () => {
        const {service} = createService();

        const fileContent = 'name: UploadedStyle';
        const file = new File([fileContent], 'uploaded.yaml', {type: 'application/x-yaml'});

        const originalFileReader = (globalThis as any).FileReader;
        class MockFileReader {
            result: string | ArrayBuffer | null = null;
            onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => any) | null = null;
            onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => any) | null = null;
            readAsText(_file: File) {
                this.result = fileContent;
                if (this.onload) {
                    this.onload.call(this as any, {} as any);
                }
            }
        }
        (globalThis as any).FileReader = MockFileReader as any;

        const initSpy = vi.spyOn(service as any, 'initializeStyle').mockReturnValue('UploadedStyle');
        const saveImportedSpy = vi.spyOn(service, 'saveImportedStyles');
        const reapplySpy = vi.spyOn(service, 'reapplyStyle');

        const result = await service.importStyleYamlFile({} as any, file, undefined);

        (globalThis as any).FileReader = originalFileReader;

        expect(result).toBe(true);
        expect(initSpy).toHaveBeenCalledWith(fileContent, '', '', false, true);
        expect(service.importedStylesCount).toBe(1);
        expect(saveImportedSpy).toHaveBeenCalled();
        expect(reapplySpy).toHaveBeenCalledWith('UploadedStyle');
    });

    it('deletes a modified imported style with optional export and restores builtin if available', async () => {
        const {service} = createService();

        const removedIds: string[] = [];
        service.styleRemovedForId.subscribe(id => removedIds.push(id));

        const featureLayerStyleStub = {
            name: () => 'ImportStyle',
            defaultEnabled: () => true,
            delete: vi.fn(),
        } as any;
        service.styles.set('ImportStyle', {
            id: 'ImportStyle',
            modified: true,
            imported: true,
            source: 'name: ImportStyle',
            featureLayerStyle: featureLayerStyleStub,
            options: [],
            shortId: 'IMP1',
            visible: true,
            url: '',
        } as any);
        service.importedStylesCount = 1;
        service.styleUrls = [{id: 'ImportStyle', url: 'bundle/styles/import.yaml'} as any];

        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const exportSpy = vi.spyOn(service, 'exportStyleYamlFile').mockReturnValue(true);
        const fetchSpy = vi.spyOn(service, 'fetchStylesYamlSources').mockResolvedValue(new Map<string, string>([
            ['bundle/styles/import.yaml', 'name: BuiltinStyle'],
        ]));
        const initSpy = vi.spyOn(service as any, 'initializeStyle').mockReturnValue('BuiltinStyle');
        const reapplySpy = vi.spyOn(service, 'reapplyStyle');

        service.deleteStyle('ImportStyle');
        await Promise.resolve();

        expect(confirmSpy).toHaveBeenCalled();
        expect(exportSpy).toHaveBeenCalledWith('ImportStyle');
        expect(featureLayerStyleStub.delete).toHaveBeenCalled();
        expect(service.styles.has('ImportStyle')).toBe(false);
        expect(service.importedStylesCount).toBe(0);
        expect(removedIds).toContain('ImportStyle');
        expect(fetchSpy).toHaveBeenCalled();
        expect(initSpy).toHaveBeenCalledWith('name: BuiltinStyle', 'bundle/styles/import.yaml', 'ImportStyle', false, false);
        expect(reapplySpy).toHaveBeenCalledWith('BuiltinStyle');
    });

    it('saves and updates style hash statuses in localStorage', () => {
        const {service} = createService();

        const hashes = (service as any).styleHashes as Map<string, {id: string, sha256: string, isModified: boolean, isUpdated: boolean}>;
        hashes.set('bundle/styles/s1.yaml', {
            id: 's1',
            sha256: 'abc',
            isModified: false,
            isUpdated: true,
        });

        service.updateStyleHashes();

        const stored = localStorage.getItem('styleHashes');
        expect(stored).not.toBeNull();
        expect(JSON.parse(stored!)).toEqual([['bundle/styles/s1.yaml', 'abc']]);
        expect(hashes.size).toBe(0);
    });

    it('clears storage keys for imported and builtin styles', () => {
        const {service} = createService();

        localStorage.setItem('importedStyleData', 'x');
        localStorage.setItem('builtinStyleData', 'y');

        service.clearStorageForImportedStyles();
        service.clearStorageForBuiltinStyles();

        expect(localStorage.getItem('importedStyleData')).toBeNull();
        expect(localStorage.getItem('builtinStyleData')).toBeNull();
    });

    it('reloads a style by fetching YAML via its URL and reapplies it', async () => {
        const {service} = createService();

        service.styles.set('StyleOne', {
            id: 'StyleOne',
            url: 'bundle/styles/style-one.yaml',
            visible: true,
        } as any);

        const fetchSpy = vi.spyOn(service, 'fetchStylesYamlSources').mockResolvedValue(
            new Map<string, string>([['bundle/styles/style-one.yaml', 'name: ReloadedStyle']]),
        );
        const initSpy = vi.spyOn(service as any, 'initializeStyle').mockReturnValue('ReloadedStyle');
        const reapplySpy = vi.spyOn(service, 'reapplyStyle');

        await service.syncStyleYamlData('StyleOne');

        expect(fetchSpy).toHaveBeenCalledWith([{id: 'StyleOne', url: 'bundle/styles/style-one.yaml'}]);
        expect(initSpy).toHaveBeenCalledWith('name: ReloadedStyle', 'bundle/styles/style-one.yaml', 'StyleOne');
        expect(reapplySpy).toHaveBeenCalledWith('ReloadedStyle');
    });

    it('clears stored modified builtin entry when reloading a style', async () => {
        const {service} = createService();

        service.styles.set('StyleOne', {
            id: 'StyleOne',
            url: 'bundle/styles/style-one.yaml',
            visible: true,
            imported: false,
            modified: true,
        } as any);
        service.saveModifiedBuiltinStyles();
        expect(localStorage.getItem('builtinStyleData')).not.toBeNull();

        vi.spyOn(service, 'fetchStylesYamlSources').mockResolvedValue(
            new Map<string, string>([['bundle/styles/style-one.yaml', 'name: StyleOne']]),
        );
        vi.spyOn(service as any, 'initializeStyle').mockImplementation((_: unknown, styleUrl: unknown) => {
            const url = styleUrl as string;
            service.styles.set('StyleOne', {
                id: 'StyleOne',
                url: url,
                visible: true,
                imported: false,
                modified: false,
            } as any);
            return 'StyleOne';
        });
        vi.spyOn(service, 'reapplyStyle').mockImplementation(() => {});

        await service.syncStyleYamlData('StyleOne');

        const stored = localStorage.getItem('builtinStyleData');
        expect(stored).toBeTruthy();
        expect(JSON.parse(stored!)).toEqual([]);
        expect(service.styles.get('StyleOne')?.modified).toBe(false);
    });
});
