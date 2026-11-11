import type {Page} from '@playwright/test';

/** Native-valid style covering the shared authoring workflow and documentation screenshots. */
const STYLE_SUPPORT_SOURCE = `# Keep this author comment
name: Style Support
version: 2
default: true
options:
  - {id: enabled, label: Enabled, type: bool, default: true}
  - {id: tint, label: Tint, type: color, default: blue}
  - {id: caption, label: Caption, type: string, default: Road}
presets:
  - {id: normal, name: Normal, values: [{optionId: enabled, value: true}]}
interaction-effects:
  hover: {tint: {option: tint}, tint-mix: 0.3, halo: {color: white, radius: 2}}
rules:
  - scope: attribute
    geometry: line
    filter: enabled
    attribute-filter: speedLimitKmh > 0
    color: red
    width: 0.25
    all-of:
      - filter: 'true'
        width: 48 # Keep this branch comment
        label-text-expression: speedLimitKmh
`;

/** Supplies one deterministic style without depending on the standalone example bundle. */
export async function installStyleSupportFixture(page: Page): Promise<void> {
    await page.route('**/static-config/config.json', async route => {
        const response = await route.fetch();
        const config = await response.json();
        await route.fulfill({response, json: {...config, styles: [{id: 'Style Support', url: 'style-support.yaml'}]}});
    });
    await page.route('**/static-config/styles/style-support.yaml', route =>
        route.fulfill({body: STYLE_SUPPORT_SOURCE, contentType: 'text/yaml'}));
}
