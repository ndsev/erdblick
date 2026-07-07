import type {Params} from "@angular/router";

export type UrlV2Primitive = string | number | boolean;

export interface UrlV2TileFeatureId {
    featureId: string;
    mapTileKey: string;
}

export interface UrlV2SelectedSourceData {
    mapTileKey: string;
    address?: bigint;
}

export interface UrlV2InspectionPanel {
    id: number;
    features: UrlV2TileFeatureId[];
    locked: boolean;
    focused?: boolean;
    size: [number, number];
    sourceData?: UrlV2SelectedSourceData;
    color: string;
    undocked: boolean;
}

export interface UrlV2LayerEncoding {
    map: string | null;
    l: string | null;
    mapNames: string[];
}

interface ParsedLayerName {
    mapId: string;
    layerId: string;
}

interface ParsedMapTileKey {
    layerType: string;
    mapId: string;
    layerId: string;
    tileId: string;
    stage: string;
}

const STYLE_PRIMITIVE_TOKEN_RE = /^(?:true|false|0|1|-?\d+(?:\.\d+)?)$/i;

/** Returns the first query-param value as a string. */
export function firstParamValue(params: Params, key: string): string | undefined {
    const value = params[key];
    if (value === undefined || value === null) {
        return undefined;
    }
    return Array.isArray(value) ? String(value[0] ?? "") : String(value);
}

/** Encodes one grammar component without encoding structural separators around it. */
function encodeToken(value: string): string {
    return encodeURIComponent(value);
}

/** Decodes one grammar component and keeps malformed legacy strings intact. */
function decodeToken(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/** Normalizes MapTileKey components whose textual form escapes delimiters such as slashes. */
function normalizeMapTileKeyComponent(value: string): string {
    return decodeToken(value);
}

/** Converts booleans and other primitive values to compact URL tokens. */
function primitiveToken(value: UrlV2Primitive | undefined): string {
    if (typeof value === "boolean") {
        return value ? "1" : "0";
    }
    if (value === undefined || value === null) {
        return "";
    }
    return encodeToken(String(value));
}

/** Checks whether a token can safely participate in run-length encoding. */
function isRunLengthPrimitiveToken(value: string): boolean {
    return STYLE_PRIMITIVE_TOKEN_RE.test(value);
}

/** Compresses adjacent repeated primitive tokens with the `<value>x<count>` form. */
function compressTokenRuns(tokens: string[]): string[] {
    const result: string[] = [];
    for (let index = 0; index < tokens.length;) {
        const token = tokens[index];
        let count = 1;
        while (index + count < tokens.length && tokens[index + count] === token) {
            count++;
        }
        if (count > 1 && isRunLengthPrimitiveToken(token)) {
            result.push(`${token}x${count}`);
        } else {
            for (let offset = 0; offset < count; offset++) {
                result.push(token);
            }
        }
        index += count;
    }
    return result;
}

/** Expands compact primitive run-length tokens. */
function expandTokenRuns(tokens: string[]): string[] {
    const result: string[] = [];
    for (const token of tokens) {
        const match = token.match(/^(.*)x(\d+)$/);
        if (!match || !isRunLengthPrimitiveToken(match[1])) {
            result.push(token);
            continue;
        }
        const count = Number(match[2]);
        if (!Number.isInteger(count) || count <= 1) {
            result.push(token);
            continue;
        }
        for (let index = 0; index < count; index++) {
            result.push(match[1]);
        }
    }
    return result;
}

/** Compresses comma-separated arrays inside an already serialized URL parameter. */
export function compressUrlCsvRuns(value: string): string {
    return value
        .split(":")
        .map(group => group.length ? compressTokenRuns(group.split(",")).join(",") : group)
        .join(":");
}

/** Splits a map/layer id into map id and layer id using the final slash. */
function parseLayerName(layerName: string): ParsedLayerName | null {
    const slashIndex = layerName.lastIndexOf("/");
    if (slashIndex <= 0 || slashIndex >= layerName.length - 1) {
        return null;
    }
    return {
        mapId: layerName.slice(0, slashIndex),
        layerId: layerName.slice(slashIndex + 1),
    };
}

/** Finds the longest common prefix for adjacent map-name compression. */
function commonPrefix(values: string[]): string {
    if (!values.length) {
        return "";
    }
    let prefix = values[0];
    for (const value of values.slice(1)) {
        while (prefix && !value.startsWith(prefix)) {
            prefix = prefix.slice(0, -1);
        }
    }
    return prefix;
}

/** Finds the longest common suffix for adjacent map-name compression. */
function commonSuffix(values: string[]): string {
    if (!values.length) {
        return "";
    }
    let suffix = values[0];
    for (const value of values.slice(1)) {
        while (suffix && !value.endsWith(suffix)) {
            suffix = suffix.slice(1);
        }
    }
    return suffix;
}

/** Computes the encoded literal form for a sequence of map names. */
function literalMapEncoding(values: string[]): string {
    return values.map(encodeToken).join("~");
}

/** Encodes map names with adjacent prefix/suffix compression when it saves space. */
export function encodeMapNamesV2(mapNames: string[]): string {
    const groups: string[] = [];
    let index = 0;
    while (index < mapNames.length) {
        let bestEncoded = encodeToken(mapNames[index]);
        let bestLength = 1;
        let bestSavings = 0;

        for (let end = index + 1; end < mapNames.length; end++) {
            const window = mapNames.slice(index, end + 1);
            const literal = literalMapEncoding(window);
            const prefix = commonPrefix(window);
            if (prefix.length) {
                const suffixes = window.map(value => value.slice(prefix.length));
                const encoded = `${encodeToken(prefix)}:${suffixes.map(encodeToken).join(",")}`;
                const savings = literal.length - encoded.length;
                if (savings > bestSavings || (savings === bestSavings && savings > 0 && window.length > bestLength)) {
                    bestEncoded = encoded;
                    bestLength = window.length;
                    bestSavings = savings;
                }
            }

            const suffix = commonSuffix(window);
            if (suffix.length) {
                const prefixes = window.map(value => value.slice(0, value.length - suffix.length));
                const encoded = `${prefixes.map(encodeToken).join(",")}:${encodeToken(suffix)}`;
                const savings = literal.length - encoded.length;
                if (savings > bestSavings || (savings === bestSavings && savings > 0 && window.length > bestLength)) {
                    bestEncoded = encoded;
                    bestLength = window.length;
                    bestSavings = savings;
                }
            }
        }

        groups.push(bestEncoded);
        index += bestLength;
    }
    return groups.join("~");
}

/** Decodes map names written by the v2 map-name compressor. */
export function decodeMapNamesV2(raw: string): string[] {
    if (!raw) {
        return [];
    }
    const result: string[] = [];
    for (const group of raw.split("~")) {
        const colonIndex = group.indexOf(":");
        if (colonIndex < 0) {
            result.push(decodeToken(group));
            continue;
        }
        const left = group.slice(0, colonIndex).split(",");
        const right = group.slice(colonIndex + 1).split(",");
        if (left.length > 1 && right.length === 1) {
            const suffix = decodeToken(right[0]);
            result.push(...left.map(prefix => `${decodeToken(prefix)}${suffix}`));
            continue;
        }
        if (right.length > 1 && left.length === 1) {
            const prefix = decodeToken(left[0]);
            result.push(...right.map(suffix => `${prefix}${decodeToken(suffix)}`));
            continue;
        }
        result.push(decodeToken(group));
    }
    return result;
}

/** Encodes the current layer order as v2 `map` plus `l` parameters. */
export function encodeLayerNamesV2(layerNames: string[], extraMapIds: string[] = []): UrlV2LayerEncoding {
    const parsedLayers = layerNames
        .map(parseLayerName)
        .filter((layer): layer is ParsedLayerName => layer !== null);
    const mapNames: string[] = [];
    const mapIndex = new Map<string, number>();
    const addMap = (mapId: string) => {
        if (!mapIndex.has(mapId)) {
            mapIndex.set(mapId, mapNames.length);
            mapNames.push(mapId);
        }
    };

    for (const layer of parsedLayers) {
        addMap(layer.mapId);
    }
    for (const mapId of extraMapIds) {
        addMap(mapId);
    }
    if (!mapNames.length || !parsedLayers.length) {
        return {
            map: mapNames.length ? encodeMapNamesV2(mapNames) : null,
            l: null,
            mapNames,
        };
    }

    const groups: string[] = [];
    let currentLayerId = "";
    let currentMapIndices: string[] = [];
    const flush = () => {
        if (currentLayerId) {
            groups.push(`${encodeToken(currentLayerId)}:${currentMapIndices.join(",")}`);
        }
    };

    for (const layer of parsedLayers) {
        const indexForMap = mapIndex.get(layer.mapId);
        if (indexForMap === undefined) {
            continue;
        }
        if (layer.layerId !== currentLayerId) {
            flush();
            currentLayerId = layer.layerId;
            currentMapIndices = [];
        }
        currentMapIndices.push(String(indexForMap));
    }
    flush();

    return {
        map: encodeMapNamesV2(mapNames),
        l: groups.join("~"),
        mapNames,
    };
}

/** Expands v2 `map` plus `l` parameters into the layerNames array. */
export function decodeLayerNamesV2(mapParam: string | undefined, layerParam: string | undefined): string[] {
    if (!mapParam || !layerParam) {
        return [];
    }
    const mapNames = decodeMapNamesV2(mapParam);
    const layerNames: string[] = [];
    for (const group of layerParam.split("~")) {
        const colonIndex = group.indexOf(":");
        if (colonIndex <= 0) {
            continue;
        }
        const layerId = decodeToken(group.slice(0, colonIndex));
        const mapIndices = expandTokenRuns(group.slice(colonIndex + 1).split(","));
        for (const token of mapIndices) {
            const index = Number(token);
            if (!Number.isInteger(index) || index < 0 || index >= mapNames.length) {
                continue;
            }
            layerNames.push(`${mapNames[index]}/${layerId}`);
        }
    }
    return layerNames;
}

/** Parses the existing MapTileKey string representation without needing WASM. */
function parseMapTileKey(mapTileKey: string): ParsedMapTileKey | null {
    const parts = mapTileKey.split(":");
    if (parts.length < 4) {
        return null;
    }
    return {
        layerType: parts[0],
        mapId: parts[1],
        layerId: parts[2],
        tileId: parts[3],
        stage: parts[4] ?? "0",
    };
}

/** Builds the existing MapTileKey string representation. */
function buildMapTileKey(layerType: string, mapId: string, layerId: string, tileId: string, stage: string): string {
    return `${layerType}:${mapId}:${layerId}:${tileId}:${stage || "0"}`;
}

/** Encodes stage zero compactly while preserving non-zero stages. */
function encodeTileAndStage(tileId: string, stage: string): string {
    return stage && stage !== "0" ? `${tileId}.${stage}` : tileId;
}

/** Decodes the compact tile/stage form used by v2 selections. */
function decodeTileAndStage(token: string): {tileId: string, stage: string} {
    const dotIndex = token.lastIndexOf(".");
    if (dotIndex <= 0 || dotIndex >= token.length - 1) {
        return {tileId: token, stage: "0"};
    }
    const stage = token.slice(dotIndex + 1);
    if (!/^\d+$/.test(stage)) {
        return {tileId: token, stage: "0"};
    }
    return {
        tileId: token.slice(0, dotIndex),
        stage,
    };
}

/** Normalizes highlight colors to the compact v2 color token. */
function encodeColor(color: string, defaultColors: readonly string[]): string {
    const normalized = color.startsWith("#") ? color.toLowerCase() : `#${color.toLowerCase()}`;
    const defaultIndex = defaultColors.findIndex(entry => entry.toLowerCase() === normalized);
    if (defaultIndex >= 0) {
        return `n${defaultIndex}`;
    }
    return normalized.slice(1);
}

/** Restores a v2 color token to a CSS hex color. */
function decodeColor(color: string | undefined, panelId: number, defaultColors: readonly string[]): string {
    if (!color) {
        return defaultColors[panelId % defaultColors.length] ?? "#ffffff";
    }
    const defaultMatch = color.match(/^n(\d+)$/);
    if (defaultMatch) {
        const index = Number(defaultMatch[1]);
        return defaultColors[index] ?? defaultColors[panelId % defaultColors.length] ?? "#ffffff";
    }
    return color.startsWith("#") ? color : `#${color}`;
}

/** Encodes panel size in em units. */
function encodeLayout(size: [number, number]): string {
    return `${size[0]},${size[1]}`;
}

/** Decodes panel size from the v2 layout token and ignores optional position fields. */
function decodeLayout(layout: string | undefined): [number, number] {
    if (!layout) {
        return [30, 40];
    }
    const parts = layout.split(",").map(value => Number(value));
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        return [parts[0], parts[1]];
    }
    return [30, 40];
}

/** Returns every SourceData-only map id needed by selection encoding. */
export function sourceDataSelectionMapIds(panels: readonly UrlV2InspectionPanel[]): string[] {
    const result: string[] = [];
    for (const panel of panels) {
        if (!panel.sourceData) {
            continue;
        }
        const parsed = parseMapTileKey(panel.sourceData.mapTileKey);
        const mapId = parsed ? normalizeMapTileKeyComponent(parsed.mapId) : null;
        if (mapId && !result.includes(mapId)) {
            result.push(mapId);
        }
    }
    return result;
}

/** Returns every feature map/layer id needed to make selected-feature URLs self-contained. */
export function featureSelectionLayerNames(panels: readonly UrlV2InspectionPanel[]): string[] {
    const result: string[] = [];
    for (const panel of panels) {
        for (const feature of panel.features) {
            const parsed = parseMapTileKey(feature.mapTileKey);
            if (!parsed) {
                continue;
            }
            const mapId = normalizeMapTileKeyComponent(parsed.mapId);
            const layerId = normalizeMapTileKeyComponent(parsed.layerId);
            const layerName = `${mapId}/${layerId}`;
            if (!result.includes(layerName)) {
                result.push(layerName);
            }
        }
    }
    return result;
}

/** Encodes inspection selections in the v2 compact selection format. */
export function encodeSelectionsV2(
    panels: readonly UrlV2InspectionPanel[],
    layerNames: readonly string[],
    mapNames: readonly string[],
    defaultColors: readonly string[]
): string | null {
    const encodedPanels: string[] = [];
    for (const panel of panels) {
        const fields = [`${panel.id}`, panel.undocked ? "1" : "0"];
        if (panel.sourceData) {
            const parsed = parseMapTileKey(panel.sourceData.mapTileKey);
            if (!parsed) {
                continue;
            }
            const mapId = normalizeMapTileKeyComponent(parsed.mapId);
            const mapIndex = mapNames.indexOf(mapId);
            if (mapIndex < 0) {
                continue;
            }
            const suffix = parsed.layerId.startsWith("SourceData-")
                ? parsed.layerId.slice("SourceData-".length)
                : parsed.layerId;
            fields.push(`SD:${mapIndex}:${encodeToken(suffix)}:${encodeTileAndStage(parsed.tileId, parsed.stage)}`);
            fields.push(panel.sourceData.address === undefined ? "" : String(panel.sourceData.address));
            fields.push(encodeLayout(panel.size));
            fields.push(encodeColor(panel.color, defaultColors));
            encodedPanels.push(fields.join("~"));
            continue;
        }

        for (const feature of panel.features) {
            const parsed = parseMapTileKey(feature.mapTileKey);
            if (!parsed) {
                continue;
            }
            const mapId = normalizeMapTileKeyComponent(parsed.mapId);
            const layerId = normalizeMapTileKeyComponent(parsed.layerId);
            const layerIndex = layerNames.indexOf(`${mapId}/${layerId}`);
            if (layerIndex < 0) {
                continue;
            }
            fields.push(`F:${layerIndex}:${encodeTileAndStage(parsed.tileId, parsed.stage)}`);
            fields.push(encodeToken(feature.featureId));
        }
        if (fields.length <= 2) {
            continue;
        }
        fields.push(encodeLayout(panel.size));
        fields.push(encodeColor(panel.color, defaultColors));
        encodedPanels.push(fields.join("~"));
    }
    return encodedPanels.length ? encodedPanels.join(";") : null;
}

/** Decodes the compact v2 selection parameter into inspection panel state. */
export function decodeSelectionsV2(
    raw: string | undefined,
    layerNames: readonly string[],
    mapNames: readonly string[],
    defaultColors: readonly string[]
): UrlV2InspectionPanel[] {
    if (!raw) {
        return [];
    }
    const result: UrlV2InspectionPanel[] = [];
    for (const panelToken of raw.split(";")) {
        const parts = panelToken.split("~");
        if (parts.length < 5) {
            continue;
        }
        const id = Number(parts[0]);
        if (!Number.isFinite(id)) {
            continue;
        }
        const undocked = parts[1] === "1";
        const payload = parts[2];
        if (payload.startsWith("SD:")) {
            const panel = decodeSourceDataPanel(parts, id, undocked, mapNames, defaultColors);
            if (panel) {
                result.push(panel);
            }
            continue;
        }
        const panel = decodeFeaturePanel(parts, id, undocked, layerNames, defaultColors);
        if (panel) {
            result.push(panel);
        }
    }
    return result;
}

/** Decodes one v2 feature panel. */
function decodeFeaturePanel(
    parts: string[],
    id: number,
    undocked: boolean,
    layerNames: readonly string[],
    defaultColors: readonly string[]
): UrlV2InspectionPanel | null {
    const color = decodeColor(parts[parts.length - 1], id, defaultColors);
    const size = decodeLayout(parts[parts.length - 2]);
    const features: UrlV2TileFeatureId[] = [];
    for (let index = 2; index < parts.length - 2;) {
        const payload = parts[index];
        if (!payload || index + 1 >= parts.length - 2) {
            break;
        }
        const payloadParts = payload.split(":");
        if (!payload.startsWith("F:")) {
            break;
        }
        const layerIndex = Number(payloadParts[1]);
        if (!Number.isInteger(layerIndex) || layerIndex < 0 || layerIndex >= layerNames.length) {
            index += 2;
            continue;
        }
        const parsedLayer = parseLayerName(layerNames[layerIndex]);
        if (!parsedLayer) {
            index += 2;
            continue;
        }
        const tile = decodeTileAndStage(payloadParts[2] ?? "");
        features.push({
            mapTileKey: buildMapTileKey("Features", parsedLayer.mapId, parsedLayer.layerId, tile.tileId, tile.stage),
            featureId: decodeToken(parts[index + 1] ?? ""),
        });
        index += 2;
    }
    if (!features.length) {
        return null;
    }
    return {
        id,
        features,
        locked: true,
        size,
        color,
        undocked,
    };
}

/** Decodes one v2 SourceData panel. */
function decodeSourceDataPanel(
    parts: string[],
    id: number,
    undocked: boolean,
    mapNames: readonly string[],
    defaultColors: readonly string[]
): UrlV2InspectionPanel | null {
    const payloadParts = parts[2].split(":");
    if (payloadParts.length < 4) {
        return null;
    }
    const mapIndex = Number(payloadParts[1]);
    if (!Number.isInteger(mapIndex) || mapIndex < 0 || mapIndex >= mapNames.length) {
        return null;
    }
    const suffix = decodeToken(payloadParts[2]);
    const layerId = suffix.startsWith("SourceData-") ? suffix : `SourceData-${suffix}`;
    const tile = decodeTileAndStage(payloadParts[3]);
    const addressToken = parts[3] ?? "";
    const layoutToken = parts[4];
    const colorToken = parts[5];
    return {
        id,
        features: [],
        sourceData: {
            mapTileKey: buildMapTileKey("SourceData", mapNames[mapIndex], layerId, tile.tileId, tile.stage),
            address: addressToken.length ? BigInt(addressToken) : undefined,
        },
        locked: true,
        size: decodeLayout(layoutToken),
        color: decodeColor(colorToken, id, defaultColors),
        undocked,
    };
}

/** Serializes style option state using v2 URL compaction. */
export function encodeStyleOptionsV2(
    styles: ReadonlyMap<string, UrlV2Primitive[]>,
    layerNames: readonly string[],
    numViews: number
): Record<string, string> {
    const grouped = new Map<string, Map<string, Map<string, UrlV2Primitive[]>>>();
    for (const [fullKey, values] of styles.entries()) {
        const fullKeyParts = fullKey.split("/");
        if (fullKeyParts.length < 4) {
            continue;
        }
        const optionId = fullKeyParts[fullKeyParts.length - 1];
        const shortStyleId = fullKeyParts[fullKeyParts.length - 2];
        const mapLayerId = fullKeyParts.slice(0, -2).join("/");
        if (!layerNames.includes(mapLayerId) || values.length < numViews) {
            continue;
        }
        if (!grouped.has(shortStyleId)) {
            grouped.set(shortStyleId, new Map());
        }
        const byOption = grouped.get(shortStyleId)!;
        if (!byOption.has(optionId)) {
            byOption.set(optionId, new Map());
        }
        byOption.get(optionId)!.set(mapLayerId, values.slice(0, numViews));
    }

    const result: Record<string, string> = {};
    for (const [shortStyleId, byOption] of grouped.entries()) {
        const layerIndices = layerNames
            .map((layerName, index) => [...byOption.values()].some(byLayer => byLayer.has(layerName)) ? index : -1)
            .filter(index => index >= 0);
        if (!layerIndices.length) {
            continue;
        }
        const optionIds = [...byOption.keys()];
        const optionBodies: string[] = [];
        for (const optionId of optionIds) {
            const byLayer = byOption.get(optionId)!;
            const perViewBodies: string[] = [];
            for (let viewIndex = 0; viewIndex < numViews; viewIndex++) {
                const tokens = layerIndices.map(layerIndex =>
                    primitiveToken(byLayer.get(layerNames[layerIndex])?.[viewIndex]));
                perViewBodies.push(compressTokenRuns(tokens).join(","));
            }
            const firstBody = perViewBodies[0];
            optionBodies.push(perViewBodies.every(body => body === firstBody) ? firstBody : perViewBodies.join(":"));
        }
        const compactOptionIds = optionIds.map(optionId =>
            optionId.startsWith("show") && optionId.length > 4 ? `.${encodeToken(optionId.slice(4))}` : encodeToken(optionId));
        result[`${encodeToken(shortStyleId)}~${layerIndices.join("-")}~${compactOptionIds.join("~")}`] = optionBodies.join("~");
    }
    return result;
}

/** Decodes v2 style option params and merges them into the provided style map. */
export function decodeStyleOptionsV2(
    params: Params,
    layerNames: readonly string[],
    numViews: number,
    currentStyles: ReadonlyMap<string, UrlV2Primitive[]>
): Map<string, UrlV2Primitive[]> {
    const next = new Map<string, UrlV2Primitive[]>(currentStyles);
    for (const [key, rawValue] of Object.entries(params)) {
        const keyParts = key.split("~");
        if (keyParts.length < 3 || !/^\d+(?:-\d+)*$/.test(keyParts[1])) {
            continue;
        }
        const shortStyleId = decodeToken(keyParts[0]);
        const layerIndices = keyParts[1].split("-").map(value => Number(value));
        const optionIds = keyParts.slice(2).map(decodeStyleOptionId);
        const value = Array.isArray(rawValue) ? String(rawValue[0] ?? "") : String(rawValue ?? "");
        const optionBodies = value.split("~");
        if (optionBodies.length < optionIds.length) {
            continue;
        }
        for (let optionIndex = 0; optionIndex < optionIds.length; optionIndex++) {
            const perViewBodies = optionBodies[optionIndex].split(":");
            const effectiveViewBodies = perViewBodies.length === 1 && numViews > 1
                ? Array.from({length: numViews}, () => perViewBodies[0])
                : perViewBodies;
            for (let viewIndex = 0; viewIndex < numViews; viewIndex++) {
                const layerTokens = expandTokenRuns((effectiveViewBodies[viewIndex] ?? "").split(","))
                    .map(decodeToken);
                for (let layerOffset = 0; layerOffset < layerIndices.length; layerOffset++) {
                    const layerIndex = layerIndices[layerOffset];
                    if (!Number.isInteger(layerIndex) || layerIndex < 0 || layerIndex >= layerNames.length) {
                        continue;
                    }
                    const values = next.get(`${layerNames[layerIndex]}/${shortStyleId}/${optionIds[optionIndex]}`) ?? [];
                    while (values.length <= viewIndex) {
                        values.push(false);
                    }
                    values[viewIndex] = layerTokens[layerOffset] ?? "";
                    next.set(`${layerNames[layerIndex]}/${shortStyleId}/${optionIds[optionIndex]}`, values);
                }
            }
        }
    }
    return next;
}

/** Restores style option ids compressed with the leading-dot `show` shorthand. */
function decodeStyleOptionId(value: string): string {
    const decoded = decodeToken(value);
    return decoded.startsWith(".") ? `show${decoded.slice(1)}` : decoded;
}
