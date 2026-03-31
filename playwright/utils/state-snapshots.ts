import * as fs from 'node:fs';
import * as path from 'node:path';

const SNAPSHOT_FILE_PATTERN = /\.json$/i;
const SNAPSHOTS_DIR = path.join(process.cwd(), 'test', 'states');

export function listStateSnapshots(): string[] {
    if (!fs.existsSync(SNAPSHOTS_DIR)) {
        return [];
    }
    return fs.readdirSync(SNAPSHOTS_DIR)
        .filter(fileName => SNAPSHOT_FILE_PATTERN.test(fileName))
        .sort((a, b) => a.localeCompare(b));
}

export function loadStateSnapshotLocalStorageEntries(selectedSnapshot: string | null): Record<string, string> | null {
    const availableSnapshots = listStateSnapshots();
    if (!availableSnapshots.length) {
        return null;
    }
    if (!selectedSnapshot) {
        return null;
    }

    const selectedFileName = selectedSnapshot.endsWith('.json') ? selectedSnapshot : `${selectedSnapshot}.json`;
    if (!availableSnapshots.includes(selectedFileName)) {
        throw new Error(
            `Unknown state snapshot '${selectedSnapshot}'. Available snapshots: ${availableSnapshots.join(', ')}`
        );
    }

    const snapshotPath = path.join(SNAPSHOTS_DIR, selectedFileName);
    const raw = fs.readFileSync(snapshotPath, {encoding: 'utf8'});
    const parsed = JSON.parse(raw);

    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error(`State snapshot '${selectedFileName}' must contain a top-level JSON object.`);
    }

    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        entries[key] = JSON.stringify(value);
    }
    return entries;
}
