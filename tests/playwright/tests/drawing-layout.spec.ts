import {expect,test} from '../fixtures/test';
import {addComparisonView,closeLayerDialog,navigateToStateSnapshotRoot,openMainMenu} from '../utils/ui-helpers';

for(const darkMode of ['off','on'] as const){
    test.describe(`drawing keyboard and layout with dark mode ${darkMode}`,()=>{
        // An 800x450 CSS viewport at DPR 2 exercises the effective layout of a 1600x900 display at 200%.
        test.use({actionTimeout:15000,darkMode,stateSnapshot:'location_navigation',stateSnapshotOnce:true,viewport:{width:800,height:450},deviceScaleFactor:2});
        test('keeps one toolbar tab stop, fits options, and follows its split-view owner',async({page},testInfo)=>{
            await page.route(/\/sources(?:\?.*)?$/,async route=>route.fulfill({response:await route.fetch(),json:[]}));
            await navigateToStateSnapshotRoot(page);
            const menu=await openMainMenu(page,'File');await menu.getByRole('menuitem',{name:/Drawing tools$/}).click();
            const toolbar=page.getByTestId('drawing-toolbar');
            const select=toolbar.getByRole('button',{name:'Select / edit',exact:true});
            await expect(select).toBeEnabled();await select.focus();await select.press('ArrowRight');
            await expect(toolbar.getByRole('button',{name:'Polyline',exact:true})).toBeFocused();
            expect(await toolbar.locator('.tool-strip button,.tool-strip input').evaluateAll(elements=>elements.filter(element=>(element as HTMLElement).tabIndex===0).length)).toBe(1);
            await page.keyboard.press('End');await expect(toolbar.getByRole('button',{name:'Close drawing toolbar'})).toBeFocused();
            await page.keyboard.press('ArrowLeft');await page.keyboard.press('Enter');
            const options=page.getByTestId('drawing-options');await expect(options).toBeInViewport({ratio:1});
            await options.getByRole('textbox',{name:'Drawing color hex'}).fill('#2266cc');await options.getByRole('textbox',{name:'Drawing color hex'}).press('Tab');
            await page.keyboard.press('Escape');await expect(options).toBeHidden();
            await expect(toolbar.getByRole('button',{name:'Drawing options'})).toBeFocused();
            await addComparisonView(page);await closeLayerDialog(page);
            await toolbar.getByRole('button',{name:'Drawing options'}).click();await page.getByRole('button',{name:'Dock at top-right',exact:true}).click();
            const owner=page.getByTestId('mapViewContainer-0');
            await expect.poll(async()=>{const view=(await owner.boundingBox())!,bar=(await toolbar.boundingBox())!;return bar.x>=view.x&&bar.x+bar.width<=view.x+view.width&&bar.y>=view.y&&bar.y+bar.height<=view.y+view.height;}).toBe(true);
            const tray=page.getByTestId('drawing-objects-tray');
            await expect(tray.getByRole('button',{name:'Save workspace',exact:true})).toBeInViewport({ratio:1});
            await expect(tray.getByRole('button',{name:'Resize Objects tray',exact:true})).toBeInViewport({ratio:1});
            const first=(await toolbar.getByRole('button',{name:'Select / edit',exact:true}).boundingBox())!,last=(await toolbar.getByRole('button',{name:'Close drawing toolbar',exact:true}).boundingBox())!;
            expect(Math.abs(first.y-last.y)).toBeLessThan(1);
            const ownerUi=page.locator('map-view').filter({has:owner});
            const scale=ownerUi.getByRole('button',{name:'Map scale',exact:true});
            const navigation=ownerUi.getByTestId('view-ui-container-0');
            for(const control of [scale,navigation]){
                const panel=(await tray.boundingBox())!,bounds=(await control.boundingBox())!;
                expect(panel.x+panel.width<=bounds.x||bounds.x+bounds.width<=panel.x||panel.y+panel.height<=bounds.y||bounds.y+bounds.height<=panel.y).toBe(true);
            }
            const scaleBounds=(await scale.boundingBox())!,navigationBounds=(await navigation.boundingBox())!;
            expect(scaleBounds.x>=navigationBounds.x+navigationBounds.width).toBe(true);
            await scale.click();await expect(ownerUi.getByTestId('map-scale')).toBeVisible();
            await page.mouse.move(0,0);await page.screenshot({path:testInfo.outputPath(`drawing-layout-${darkMode}.png`),fullPage:true,animations:'disabled'});
        });
    });
}
