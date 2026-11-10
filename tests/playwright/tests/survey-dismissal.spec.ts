import {expect, test} from '@playwright/test';
import {dismissSurveyIfPresent} from '../utils/ui-helpers';

test.describe('survey dismissal setup', () => {
    test('allows an absent or already hidden survey', async ({page}) => {
        await page.setContent('<main>No survey</main>');
        await dismissSurveyIfPresent(page);

        await page.setContent('<div id="survey" hidden></div>');
        await dismissSurveyIfPresent(page);
    });

    test('waits for a visible survey to be dismissed', async ({page}) => {
        // A completed click alone is insufficient when the close handler defers hiding.
        await page.setContent(`
            <div id="survey">
                <button class="material-symbols-outlined"
                        onclick="setTimeout(() => this.parentElement.hidden = true, 1000)">close</button>
            </div>
        `);

        await dismissSurveyIfPresent(page);
        expect(await page.locator('#survey').isHidden()).toBe(true);
    });

    test('propagates a failed close action instead of continuing setup', async ({page}) => {
        await page.setContent(`
            <div id="survey">
                <button class="material-symbols-outlined" disabled>close</button>
            </div>
        `);
        // Deliberately fail this action, without spending the suite's normal action budget.
        page.setDefaultTimeout(100);

        await expect(dismissSurveyIfPresent(page)).rejects.toThrow(/Timeout/);
        await expect(page.locator('#survey')).toBeVisible();
    });
});
