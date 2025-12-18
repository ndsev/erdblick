function readEnv(name: string, fallback: string): string {
    const value = process.env[name];
    return value === undefined || value === '' ? fallback : value;
}

function parsePosition(raw: string): [number, number, number] {
    const trimmed = raw.trim();
    let parts: unknown;

    if (trimmed.startsWith('[')) {
        parts = JSON.parse(trimmed);
    } else {
        parts = trimmed
            .split(/[,\s]+/)
            .map((entry) => entry.trim())
            .filter(Boolean);
    }

    if (!Array.isArray(parts) || parts.length !== 3) {
        throw new Error(
            `Expected EB_TEST_VIEW_POSITION to be a 3-item array (got: ${raw})`
        );
    }

    const numbers = parts.map((value) => {
        const asNumber = typeof value === 'number' ? value : Number(String(value));
        if (!Number.isFinite(asNumber)) {
            throw new Error(
                `Expected EB_TEST_VIEW_POSITION entries to be numbers (got: ${raw})`
            );
        }
        return asNumber;
    }) as number[];

    return [numbers[0], numbers[1], numbers[2]];
}

export const TEST_MAP_NAME = readEnv('EB_TEST_MAP_NAME', 'TestMap');
export const TEST_LAYER_NAME = readEnv('EB_TEST_LAYER_NAME', 'WayLayer');
export const TEST_VIEW_POSITION = parsePosition(
    readEnv('EB_TEST_VIEW_POSITION', '[42.5,11.615,13]')
);
export const TEST_MAP_LAYER_DATA_ID = `${TEST_MAP_NAME}/${TEST_LAYER_NAME}`;

