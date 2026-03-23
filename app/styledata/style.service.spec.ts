import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {of, BehaviorSubject} from 'rxjs';

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
        expect(hashes.size).toBe(1);
        expect(hashes.get('bundle/styles/s1.yaml')?.isUpdated).toBe(false);
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
                source: 'name: StyleOne',
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

    it('reloads modified builtin styles by matching builtin URL, not insertion order', () => {
        const {service} = createService();

        service.styles.set('StyleA', {
            id: 'StyleA',
            url: 'bundle/styles/a.yaml',
            source: 'name: StyleA',
            imported: false,
            modified: false,
            visible: true,
        } as any);
        service.styles.set('StyleB', {
            id: 'StyleB',
            url: 'bundle/styles/b.yaml',
            source: 'name: StyleB',
            imported: false,
            modified: false,
            visible: true,
        } as any);

        localStorage.setItem('builtinStyleData', JSON.stringify([
            ['StyleB', {
                id: 'StyleB',
                url: 'bundle/styles/b.yaml',
                source: 'name: StyleB\nlayers: []',
                imported: false,
            }],
        ]));

        const initSpy = vi.spyOn(service as any, 'initializeStyle').mockReturnValue('StyleB');

        service.loadModifiedBuiltinStyles();

        expect(initSpy).toHaveBeenCalledWith(
            'name: StyleB\nlayers: []',
            'bundle/styles/b.yaml',
            'StyleB',
            true,
            false
        );
    });

    it('persists visibility before delayed reapply so toggles do not bounce back', () => {
        const {service, stateService} = createService();

        service.styles.set('StyleOne', {
            id: 'StyleOne',
            url: 'bundle/styles/style-one.yaml',
            source: 'name: StyleOne',
            imported: false,
            modified: false,
            visible: true,
            featureLayerStyle: {
                defaultEnabled: () => true,
            },
            options: [],
            shortId: 'S1',
        } as any);

        service.toggleStyle('StyleOne', false, true);

        expect(stateService.getStyleVisibility('StyleOne', true)).toBe(false);
        expect(service.styles.get('StyleOne')?.visible).toBe(false);
    });

    it('keeps builtin baseline source when modified local override is loaded', async () => {
        const {service, httpClient} = createService();
        localStorage.setItem('builtinStyleData', JSON.stringify([
            ['BuiltinStyle', {
                id: 'BuiltinStyle',
                url: 'bundle/styles/base.yaml',
                source: 'name: BuiltinStyle\nrules:\n  - color: "#ff00ff"',
                imported: false,
            }],
        ]));
        httpClient.get.mockImplementation((url: string) => {
            if (url === 'config.json') {
                return of({styles: [{id: 'builtin', url: 'base.yaml'}]});
            }
            if (url === 'bundle/styles/base.yaml') {
                return of('name: BuiltinStyle\nrules:\n  - color: "#0000ff"');
            }
            throw new Error(`Unexpected URL ${url}`);
        });
        vi.spyOn(service as any, 'parseWasmStyle').mockImplementation((source: string) => {
            const match = source.match(/^\s*name\s*:\s*([^\n]+)/m);
            const styleName = (match?.[1] ?? 'BuiltinStyle').trim();
            return [{
                name: () => styleName,
                defaultEnabled: () => true,
                delete: vi.fn(),
            }, []];
        });

        await service.initializeStyles();

        expect(service.getBuiltinBaselineSource('BuiltinStyle')).toBe('name: BuiltinStyle\nrules:\n  - color: "#0000ff"');
        expect(service.styles.get('BuiltinStyle')?.source).toBe('name: BuiltinStyle\nrules:\n  - color: "#ff00ff"');
        expect(service.styleHashes.get('bundle/styles/base.yaml')?.isModified).toBe(true);
    });

    it('synchronizes lifecycle modified flag when style source is edited', () => {
        const {service} = createService();
        service.styleUrls = [{id: 'StyleOne', url: 'bundle/styles/style-one.yaml'} as any];
        service.styleHashes.set('bundle/styles/style-one.yaml', {
            id: 'StyleOne',
            sha256: 'server',
            isModified: false,
            isUpdated: false
        });
        service.styles.set('StyleOne', {
            id: 'StyleOne',
            url: 'bundle/styles/style-one.yaml',
            source: 'name: StyleOne',
            imported: false,
            modified: false,
            visible: true,
        } as any);
        vi.spyOn(service as any, 'initializeStyle').mockImplementation((_source: string, styleUrl: string) => {
            service.styles.set('StyleOne', {
                id: 'StyleOne',
                url: styleUrl,
                source: 'name: StyleOne\nrules: []',
                imported: false,
                modified: true,
                visible: true,
            } as any);
            return 'StyleOne';
        });
        vi.spyOn(service, 'reapplyStyle').mockImplementation(() => {});

        const newStyleId = service.setStyleSource('StyleOne', 'name: StyleOne\nrules: []', true);

        expect(newStyleId).toBe('StyleOne');
        expect(service.styleHashes.get('bundle/styles/style-one.yaml')?.isModified).toBe(true);
    });

    it('resets one modified builtin style to cached baseline and clears override state', () => {
        const {service} = createService();
        const builtinUrl = 'bundle/styles/style-one.yaml';
        service.styleUrls = [{id: 'StyleOne', url: builtinUrl} as any];
        service.styles.set('StyleOne', {
            id: 'StyleOne',
            url: builtinUrl,
            source: 'name: StyleOne\nrules:\n  - modified',
            imported: false,
            modified: true,
            visible: true,
        } as any);
        (service as any).builtinStyleBaselines.set(builtinUrl, {
            id: 'StyleOne',
            source: 'name: StyleOne\nrules:\n  - original'
        });
        service.styleHashes.set(builtinUrl, {
            id: 'StyleOne',
            sha256: 'server-hash',
            isModified: true,
            isUpdated: true
        });
        vi.spyOn(service as any, 'initializeStyle').mockImplementation((source: string, styleUrl: string) => {
            service.styles.set('StyleOne', {
                id: 'StyleOne',
                url: styleUrl,
                source,
                imported: false,
                modified: false,
                visible: true,
            } as any);
            return 'StyleOne';
        });
        const reapplySpy = vi.spyOn(service, 'reapplyStyle').mockImplementation(() => {});

        const restoredStyleId = service.resetModifiedBuiltinStyle('StyleOne');

        expect(restoredStyleId).toBe('StyleOne');
        expect(reapplySpy).toHaveBeenCalledWith('StyleOne');
        expect(service.styleHashes.get(builtinUrl)?.isModified).toBe(false);
        expect(service.styleHashes.get(builtinUrl)?.isUpdated).toBe(true);
        const stored = localStorage.getItem('builtinStyleData');
        expect(stored).toBeTruthy();
        expect(JSON.parse(stored!)).toEqual([]);
    });
});
