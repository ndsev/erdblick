export type TestViewPosition = [number, number, number];

function readEnv(name: string, fallback: string): string {
    const value = process.env[name];
    return value === undefined || value === '' ? fallback : value;
}

function parseStringArray(name: string, raw: string): string[] {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('[')) {
        return [trimmed];
    }

    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error(`Expected ${name} to be a non-empty JSON array (got: ${raw})`);
    }

    return parsed.map((value) => {
        if (typeof value !== 'string') {
            throw new Error(`Expected ${name} entries to be strings (got: ${raw})`);
        }

        const result = value.trim();
        if (!result) {
            throw new Error(`Expected ${name} entries to be non-empty strings (got: ${raw})`);
        }

        return result;
    });
}

function parsePosition(value: unknown, raw: string): TestViewPosition {
    let parts: unknown;

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('[')) {
            parts = JSON.parse(trimmed);
        } else {
            parts = trimmed
                .split(/[,\s]+/)
                .map((entry) => entry.trim())
                .filter(Boolean);
        }
    } else {
        parts = value;
    }

    if (!Array.isArray(parts) || parts.length !== 3) {
        throw new Error(
            `Expected EB_TEST_VIEW_POSITION entries to be 3-item arrays (got: ${raw})`
        );
    }

    const numbers = parts.map((entry) => {
        const asNumber = typeof entry === 'number' ? entry : Number(String(entry));
        if (!Number.isFinite(asNumber)) {
            throw new Error(
                `Expected EB_TEST_VIEW_POSITION entries to be numbers (got: ${raw})`
            );
        }
        return asNumber;
    }) as number[];

    return [numbers[0], numbers[1], numbers[2]];
}

function parsePositionArray(raw: string): TestViewPosition[] {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('[')) {
        return [parsePosition(trimmed, raw)];
    }

    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error(
            `Expected EB_TEST_VIEW_POSITION to be a non-empty JSON array (got: ${raw})`
        );
    }

    const looksLikeSinglePosition =
        parsed.length === 3 &&
        parsed.every((entry) => typeof entry === 'number' || typeof entry === 'string');

    if (looksLikeSinglePosition) {
        return [parsePosition(parsed, raw)];
    }

    return parsed.map((entry) => parsePosition(entry, raw));
}

export const TEST_MAP_NAMES = parseStringArray(
    'EB_TEST_MAP_NAME',
    readEnv('EB_TEST_MAP_NAME', '["TestMap"]')
);
export const TEST_LAYER_NAMES = parseStringArray(
    'EB_TEST_LAYER_NAME',
    readEnv('EB_TEST_LAYER_NAME', '["WayLayer"]')
);
export const TEST_VIEW_POSITIONS = parsePositionArray(
    readEnv('EB_TEST_VIEW_POSITION', '[[42.5,11.615,13]]')
);

