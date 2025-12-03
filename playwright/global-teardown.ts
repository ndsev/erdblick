import type { FullConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

interface GlobalState {
    mapgetPid: number | null;
    baseURL: string;
}

async function globalTeardown(config: FullConfig): Promise<void> {
    const configDir = process.cwd();
    const statePath = path.join(configDir, 'playwright', '.cache', 'global-state.json');

    if (!fs.existsSync(statePath)) {
        return;
    }

    let state: GlobalState | null = null;
    try {
        const content = fs.readFileSync(statePath, 'utf-8');
        state = JSON.parse(content) as GlobalState;
    } catch {
        state = null;
    }

    if (state && state.mapgetPid) {
        try {
            process.kill(state.mapgetPid);
        } catch {
            // ignore if already exited
        }
    }
}

export default globalTeardown;

