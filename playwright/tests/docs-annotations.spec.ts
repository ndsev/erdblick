import {expect, test} from '@playwright/test';
import {captureDocsScreenshotWithLabels} from '../utils/ui-helpers';

test('strict annotations reject a control covered by another panel', async ({page}, testInfo) => {
    await page.setContent(`<button data-testid="target" style="position:fixed;left:100px;top:100px;width:120px;height:40px">Save</button>
        <div style="position:fixed;left:100px;top:100px;width:120px;height:40px;z-index:10;background:white">Other panel</div>`);
    await expect(captureDocsScreenshotWithLabels(page, testInfo.outputPath('covered.png'), [
        {locator: page.getByTestId('target'), label: 'Save changes'}
    ], {strict: true})).rejects.toThrow('clipped or obscured');
    await expect(page.locator('#__erdblick-doc-labels__')).toHaveCount(0);
});

test('strict annotation layout cleans up after a clipped label fails', async ({page}, testInfo) => {
    await page.setContent('<button data-testid="target" style="position:fixed;left:100px;top:5px">Save</button>');
    await expect(captureDocsScreenshotWithLabels(page, testInfo.outputPath('clipped.png'), [
        {locator: page.getByTestId('target'), label: 'Save changes', placement: 'top'}
    ], {strict: true})).rejects.toThrow('viewport edge');
    await expect(page.locator('#__erdblick-doc-labels__')).toHaveCount(0);
});

test('strict annotations capture exposed controls without changing their state', async ({page}, testInfo) => {
    await page.setContent('<button data-testid="target" style="position:fixed;left:100px;top:100px">Save</button>');
    await captureDocsScreenshotWithLabels(page, testInfo.outputPath('annotated.png'), [
        {locator: page.getByTestId('target'), label: 'Save changes', placement: 'bottom'}
    ], {strict: true, fontSize: 16});
    await expect(page.locator('#__erdblick-doc-labels__')).toHaveCount(0);
    await expect(page.getByTestId('target')).toHaveText('Save');
});


test('strict annotations check non-interactive overlays and restore hit testing', async ({page}, testInfo) => {
    await page.setContent('<div data-testid="target" style="pointer-events:none;position:fixed;left:100px;top:100px;width:180px;height:50px;background:white">Feature label</div>');
    const target = page.getByTestId('target');
    await captureDocsScreenshotWithLabels(page, testInfo.outputPath('overlay.png'), [
        {locator: target, label: 'Hover labels', placement: 'right'}
    ], {strict: true});
    await expect(target).toHaveCSS('pointer-events', 'none');
    await page.evaluate(() => {
        const cover = document.createElement('div');
        cover.style.cssText = 'position:fixed;left:100px;top:100px;width:180px;height:50px;background:red;z-index:10';
        document.body.append(cover);
    });
    await expect(captureDocsScreenshotWithLabels(page, testInfo.outputPath('covered-overlay.png'), [
        {locator: target, label: 'Hover labels'}
    ], {strict: true})).rejects.toThrow('clipped or obscured');
    await expect(target).toHaveCSS('pointer-events', 'none');
});

test('strict annotations check the bounds of an unfilled SVG navigation ring', async ({page}, testInfo) => {
    await page.setContent('<svg style="position:fixed;inset:0;width:100%;height:100%;pointer-events:none"><circle data-testid="target" cx="200" cy="200" r="40" fill="none" stroke="orange" stroke-width="3"/></svg>');
    const target = page.getByTestId('target');
    await captureDocsScreenshotWithLabels(page, testInfo.outputPath('navigation.png'), [
        {locator: target, label: 'Rotation anchor', placement: 'right'}
    ], {strict: true});
    await expect(target).toHaveCSS('pointer-events', 'none');
    await page.evaluate(() => {
        const cover = document.createElement('div');
        cover.style.cssText = 'position:fixed;left:150px;top:150px;width:100px;height:100px;background:red;z-index:10';
        document.body.append(cover);
    });
    await expect(captureDocsScreenshotWithLabels(page, testInfo.outputPath('covered-navigation.png'), [
        {locator: target, label: 'Rotation anchor'}
    ], {strict: true})).rejects.toThrow('clipped or obscured');
    await expect(target).toHaveCSS('pointer-events', 'none');
});

test('explicit wrapped labels can fan out from adjacent toolbar buttons', async ({page}, testInfo) => {
    await page.setContent('<button id="a" style="position:fixed;left:300px;top:200px">Clone</button><button id="b" style="position:fixed;left:370px;top:200px">Export</button>');
    await captureDocsScreenshotWithLabels(page, testInfo.outputPath('toolbar.png'), [
        {locator: page.locator('#a'), label: 'Clone this search and change its view scope', at: [80, 80], labelWidth: 150},
        {locator: page.locator('#b'), label: 'Export the matching features as JSON', at: [480, 80], labelWidth: 150, shape: 'circle', outlinePadding: 10}
    ], {strict: true, fontSize: 16});
    await expect(page.locator('#__erdblick-doc-labels__')).toHaveCount(0);
    await expect(captureDocsScreenshotWithLabels(page, testInfo.outputPath('collision.png'), [
        {locator: page.locator('#a'), label: 'Clone', at: [80, 80]},
        {locator: page.locator('#b'), label: 'Export', at: [80, 80]}
    ], {strict: true})).rejects.toThrow('overlaps');
    await expect(page.locator('#__erdblick-doc-labels__')).toHaveCount(0);
});

test('group labels span visible endpoints and reject an obscured endpoint', async ({page}, testInfo) => {
    await page.setContent('<button id="start" style="position:fixed;left:100px;top:100px">File</button><button id="end" style="position:fixed;left:400px;top:100px">Help</button>');
    const labels = [{locator: page.locator('#start'), through: page.locator('#end'), label: 'Application menus', placement: 'bottom' as const}];
    await captureDocsScreenshotWithLabels(page, testInfo.outputPath('group.png'), labels, {strict: true});
    await page.evaluate(() => {
        const cover = document.createElement('div');
        cover.style.cssText = 'position:fixed;left:390px;top:90px;width:100px;height:50px;background:white;z-index:10';
        document.body.append(cover);
    });
    await expect(captureDocsScreenshotWithLabels(page, testInfo.outputPath('covered-group.png'), labels, {strict: true})).rejects.toThrow('clipped or obscured');
});

test('a clear straight connector can meet an outline away from its midpoint', async ({page}, testInfo) => {
    await page.setContent('<button id="target" style="position:fixed;left:100px;top:150px;width:200px;height:120px">Results</button>');
    const screenshot = page.screenshot.bind(page);
    let inspected = false;
    page.screenshot = async options => {
        page.screenshot = screenshot;
        const points = await page.locator('[data-docs-route]').evaluate(element =>
            [...element.getAttribute('d')!.matchAll(/[ML] ([\d.]+) ([\d.]+)/g)].map(match => ({x: Number(match[1]), y: Number(match[2])})));
        expect(points).toHaveLength(2);
        expect(points[0].y).toBe(points[1].y);
        expect(points[0].y).not.toBe(210);
        inspected = true;
        return screenshot(options);
    };
    await captureDocsScreenshotWithLabels(page, testInfo.outputPath('straight.png'), [
        {locator: page.locator('#target'), label: 'Explore matching features', at: [400, 180], labelWidth: 300}
    ], {strict: true, fontSize: 16});
    expect(inspected).toBe(true);
});

for (const circle of [false, true]) {
    test(`a diagonal connector meets painted rounded edges: ${circle ? 'circle' : 'rectangle'}`, async ({page}, testInfo) => {
        await page.setContent('<button id="target" style="position:fixed;left:100px;top:150px;width:80px;height:40px">Color</button>');
        const screenshot = page.screenshot.bind(page);
        let inspected = false;
        page.screenshot = async options => {
            page.screenshot = screenshot;
            const geometry = await page.locator('#__erdblick-doc-labels__').evaluate(root => {
                const line = root.querySelector('path')!;
                const points = [...line.getAttribute('d')!.matchAll(/[ML] ([\d.]+) ([\d.]+)/g)].map(m => ({x: Number(m[1]), y: Number(m[2])}));
                const outline = [...root.children].find(e => e instanceof HTMLElement && e.style.borderStyle === 'solid' && !e.textContent)!;
                const label = [...root.children].find(e => e instanceof HTMLElement && !!e.textContent)!;
                const bounds = (e: Element) => {const r = e.getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom};};
                return {points, outline:bounds(outline), label:bounds(label)};
            });
            const [start, end] = geometry.points;
            expect(geometry.points).toHaveLength(2);
            expect(start.x).not.toBe(end.x);
            expect(start.y).not.toBe(end.y);
            // The initial ports are the four painted side midpoints, even for ellipses.
            const r = geometry.outline;
            expect(Math.min(...[
                [r.left, (r.top+r.bottom)/2], [r.right, (r.top+r.bottom)/2],
                [(r.left+r.right)/2, r.top], [(r.left+r.right)/2, r.bottom]
            ].map(([x,y]) => Math.hypot(start.x-x, start.y-y)))).toBeLessThan(1);
            const label = geometry.label;
            const radius = Math.min(label.right-label.left, label.bottom-label.top)/2;
            const nearestX = Math.max(label.left+radius, Math.min(end.x,label.right-radius));
            expect(Math.min(
                Math.hypot(end.x-label.left,end.y-(label.top+label.bottom)/2),
                Math.hypot(end.x-label.right,end.y-(label.top+label.bottom)/2),
                Math.hypot(end.x-nearestX,end.y-label.top), Math.hypot(end.x-nearestX,end.y-label.bottom)
            )).toBeLessThan(1);
            inspected = true;
            return screenshot(options);
        };
        await captureDocsScreenshotWithLabels(page, testInfo.outputPath('diagonal.png'), [
            {locator: page.locator('#target'), label: 'Choose the highlight color', at: [400, 320], labelWidth: 260,
                shape: circle ? 'circle' : undefined}
        ], {strict:true,fontSize:16});
        expect(inspected).toBe(true);
    });
}

test('a blocked diagonal routes around the intervening target', async ({page}, testInfo) => {
    await page.setViewportSize({width:1600,height:900});
    await page.setContent('<button id="target" style="position:fixed;left:100px;top:200px;width:80px;height:40px">Color</button>' +
        '<button id="obstacle" style="position:fixed;left:300px;top:100px;width:100px;height:450px">Other controls</button>');
    const screenshot = page.screenshot.bind(page);
    let inspected = false;
    page.screenshot = async options => {
        page.screenshot = screenshot;
        const path = page.locator('[data-docs-route="Choose a color"]');
        const result = await path.evaluate(element => {
            const line = element as SVGPathElement;
            const bounds = document.getElementById('obstacle')!.getBoundingClientRect();
            let crosses = false;
            for (let distance=0;distance<=line.getTotalLength();distance+=.5) {
                const point = line.getPointAtLength(distance);
                if (point.x>bounds.left && point.x<bounds.right && point.y>bounds.top && point.y<bounds.bottom) crosses=true;
            }
            return {crosses, vertices:[...line.getAttribute('d')!.matchAll(/[ML]/g)].length};
        });
        expect(result.crosses).toBe(false);
        expect(result.vertices).toBeGreaterThan(2);
        inspected = true;
        return screenshot(options);
    };
    await captureDocsScreenshotWithLabels(page, testInfo.outputPath('blocked-diagonal.png'), [
        {locator:page.locator('#target'),label:'Choose a color',at:[600,350],labelWidth:220},
        {locator:page.locator('#obstacle'),label:'Other controls',at:[440,80],labelWidth:160}
    ], {strict:true,fontSize:16});
    expect(inspected).toBe(true);
});

test('separate diagonal connectors may overlap bounding boxes without crossing', async ({page}, testInfo) => {
    await page.setContent('<button id="a" style="position:fixed;left:100px;top:100px;width:40px;height:30px">A</button>' +
        '<button id="b" style="position:fixed;left:100px;top:230px;width:40px;height:30px">B</button>');
    const screenshot = page.screenshot.bind(page);
    let inspected = false;
    page.screenshot = async options => {
        page.screenshot = screenshot;
        const routes = await page.locator('[data-docs-route]').evaluateAll(elements => elements.map(e => {
            const line=e as SVGPathElement;
            const bounds=line.getBBox();
            let touchesOther=false;
            for(let distance=0;distance<=line.getTotalLength();distance+=.5) {
                const point=line.getPointAtLength(distance);
                if(elements.some(other=>other!==e && (other as SVGPathElement).isPointInStroke(point))) touchesOther=true;
            }
            return {vertices:[...line.getAttribute('d')!.matchAll(/[ML]/g)].length,touchesOther,
                bounds:{left:bounds.x,top:bounds.y,right:bounds.x+bounds.width,bottom:bounds.y+bounds.height}};
        }));
        expect(routes).toHaveLength(2);
        for(const route of routes) {expect(route.vertices).toBe(2);expect(route.touchesOther).toBe(false);}
        expect(Math.max(routes[0].bounds.top,routes[1].bounds.top)).toBeLessThan(Math.min(routes[0].bounds.bottom,routes[1].bounds.bottom));
        expect(Math.max(routes[0].bounds.left,routes[1].bounds.left)).toBeLessThan(Math.min(routes[0].bounds.right,routes[1].bounds.right));
        inspected=true;
        return screenshot(options);
    };
    await captureDocsScreenshotWithLabels(page,testInfo.outputPath('parallel-diagonals.png'),[
        {locator:page.locator('#a'),label:'First group of controls',at:[600,300],labelWidth:220},
        {locator:page.locator('#b'),label:'Second group of controls',at:[600,440],labelWidth:220}
    ],{strict:true,fontSize:16});
    expect(inspected).toBe(true);
});

for (const layout of [
    {name: 'settings fan-out', targets: Array.from({length: 5}, (_, i) => [50, 150+i*45, 250, 35]), labels: Array.from({length: 5}, (_, i) => [460, 95+i*95]), width: 230, fontSize: 16},
    {name: 'label entry beside an earlier connector', targets: [[57,181,40,30],[615,106,40,30],[64,369,40,30]], labels: [[1007,740],[1257,492],[962,455]], width: 180, fontSize: 15}
]) {
    test(`connectors meet label edges without crossings: ${layout.name}`, async ({page}, testInfo) => {
        await page.setViewportSize({width: 1600, height: 900});
        await page.setContent(layout.targets.map(([x,y,w,h], i) => `<button id="row-${i}" style="position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px">${i}</button>`).join(''));
        const screenshot = page.screenshot.bind(page);
        let inspected = false;
        page.screenshot = async options => {
            page.screenshot = screenshot;
            const paths = await page.locator('[data-docs-route]').evaluateAll(elements => elements.map(e => ({
                name: e.getAttribute('data-docs-route'),
                points: [...e.getAttribute('d')!.matchAll(/[ML] ([\d.]+) ([\d.]+)/g)].map(m => ({x: Number(m[1]), y: Number(m[2])}))
            })));
            const labels = await page.locator('#__erdblick-doc-labels__ > div').evaluateAll(elements => elements.filter(e => e.textContent).map(e => {
                const r = e.getBoundingClientRect(); return {name:e.textContent, left:r.left, right:r.right, top:r.top, bottom:r.bottom};
            }));
            for (const path of paths) {
                const label = labels.find(l => l.name === path.name)!;
                const end = path.points.at(-1)!;
                // A capsule's flat top/bottom edge also accepts straight lines.
                const radius = Math.min(label.right-label.left, label.bottom-label.top)/2;
                const edgeX = Math.max(label.left+radius, Math.min(end.x,label.right-radius));
                expect(Math.min(
                    Math.hypot(end.x-label.left,end.y-(label.top+label.bottom)/2),
                    Math.hypot(end.x-label.right,end.y-(label.top+label.bottom)/2),
                    Math.hypot(end.x-edgeX,end.y-label.top),
                    Math.hypot(end.x-edgeX,end.y-label.bottom)
                )).toBeLessThan(1);
            }
            // Inspect the actual SVG strokes so diagonal routes are checked as
            // painted lines, rather than treating their whole bounding boxes as filled.
            const collisions = await page.locator('[data-docs-route]').evaluateAll((elements, labels) => {
                const failures:string[]=[];
                for(const element of elements) {
                    const line=element as SVGPathElement;
                    const name=line.getAttribute('data-docs-route');
                    for(let distance=0;distance<=line.getTotalLength();distance+=.5) {
                        const point=line.getPointAtLength(distance);
                        if(labels.some(label=>label.name!==name && point.x>label.left && point.x<label.right && point.y>label.top && point.y<label.bottom)) failures.push(`${name}: label`);
                        if(elements.some(other=>other!==element && (other as SVGPathElement).isPointInStroke(point))) failures.push(`${name}: connector`);
                    }
                }
                return failures;
            },labels);
            expect(collisions,'Separate callouts must not cross labels or connectors').toEqual([]);
            inspected = true;
            return screenshot(options);
        };
        await captureDocsScreenshotWithLabels(page, testInfo.outputPath('routed.png'), layout.labels.map((at,i) => ({
            locator:page.locator(`#row-${i}`), label:`Explain setting ${i} in detail`, at:at as [number,number], labelWidth:layout.width
        })), {strict:true,fontSize:layout.fontSize});
        expect(inspected).toBe(true);
    });

}
