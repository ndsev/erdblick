import {expect, test} from '../fixtures/test';
import {captureDocsScreenshotWithLabels, navigateToStateSnapshotRoot, openMainMenu, waitForAppReady} from '../utils/ui-helpers';
import {mcpClient} from '../utils/mcp-client';
import type {Page} from '@playwright/test';
import {createDeckMapViewport, DECK_MAP_FOV_DEGREES} from '../../../app/mapview/deck/navigation/web-mercator-feature-navigation.adapter';

test.use({stateSnapshot:'location_navigation',stateSnapshotOnce:true,actionTimeout:20000});
/** Read the current target before an ordinary command; stale-target cases supply their own explicit values. */
async function action(page:Page,name:string,input:Record<string,unknown>={}) {
    const outcome=await page.evaluate(async({name,input})=>{
        try {
            if(name==='workspace'&&['open','save','discard','close','select'].includes(String(input.action))&&!input.workspace)input.workspace=(await window.ebDebug.executeAction('viewer_drawing_list',{}) as any).workspace;
            if(name==='history'&&input.revision===undefined)input.revision=(await window.ebDebug.executeAction('viewer_drawing_objects',{mapId:input.mapId}) as any).revision;
            return {ok:true,result:await window.ebDebug.executeAction('viewer_drawing_'+name,input)};
        } catch(error) {
            // Firefox's evaluation wrapper can report a rejected read as a page error even when polling retries it.
            return {ok:false,error:error instanceof Error?error.message:String(error)};
        }
    },{name,input});
    if(!outcome.ok)throw new Error(outcome.error);
    return outcome.result as any;
}
async function start(page:Page) {
    await page.route(/\/sources(?:\?.*)?$/,async route=>route.fulfill({response:await route.fetch(),json:[]}));
    await navigateToStateSnapshotRoot(page);
    const menu=await openMainMenu(page,'File');await menu.getByRole('menuitem',{name:/Measure distance$/}).click();
    await expect(page.getByTestId('drawing-toolbar')).toBeVisible();
}

test('draws before naming, saves a collection, restores it, drags an annotation and undoes deletion',async({page,browserName},testInfo)=>{
    const errors:string[]=[], requests:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(/drawing-[0-9a-f]{8}-/.test(request.url()+(request.postData()??'')))requests.push(request.url());});
    await start(page); const toolbar=page.getByTestId('drawing-toolbar');
    const bounds=(await page.locator('canvas').first().boundingBox())!;
    const a={x:bounds.x+bounds.width*.18,y:bounds.y+bounds.height*.4}, b={x:a.x+100,y:a.y+40};
    await page.mouse.click(a.x,a.y);await expect(toolbar.getByTestId('measurement-points')).toHaveText('1 positions');
    await page.mouse.click(b.x,b.y);await toolbar.getByRole('button',{name:'Finish drawing',exact:true}).click();
    await expect.poll(async()=>{const docs=await action(page,'list');return docs.documents.length ? (await action(page,'objects',{mapId:docs.documents[0].mapId})).total : 0;}).toBe(1);
    await expect.poll(()=>page.evaluate(()=>window.ebDebug.subsetRenderPresentation().labels)).toBeGreaterThanOrEqual(1);
    await toolbar.getByTestId('drawing-tool-annotation').click();
    const label={x:a.x,y:a.y+150};await page.mouse.click(label.x,label.y);
    await toolbar.getByLabel('Text',{exact:true}).fill('Über <b>plain text</b>');await toolbar.getByRole('button',{name:'Place annotation',exact:true}).click();
    await expect.poll(async()=>{const docs=await action(page,'list');return (await action(page,'objects',{mapId:docs.documents[0].mapId})).total;}).toBe(2);
    await page.getByRole('button',{name:'Save workspace',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Save workspace',exact:true});await dialog.getByLabel('Name',{exact:true}).fill('Survey');
    await dialog.getByLabel('Collection · one document per object').check();await dialog.getByTestId('drawing-save-confirm').click();await expect(dialog).toBeHidden();
    let docs=(await action(page,'list')).documents;expect(docs).toHaveLength(2);expect(docs.every((doc:any)=>doc.saved&&!doc.dirty)).toBe(true);
    await page.reload();await waitForAppReady(page);await expect.poll(async()=>(await action(page,'list')).documents.length).toBe(2);docs=(await action(page,'list')).documents;
    await page.getByTestId('maps-toggle').click();
    await page.getByRole('button',{name:'Edit '+docs[1].name,exact:true}).click();
    if(await page.getByTestId('map-tree-0').isVisible())await page.getByTestId('maps-toggle').click();
    const editor=page.locator('editor-surface[data-editor-kind="drawing"]');
    await editor.getByRole('button',{name:'Open collection in Objects tray',exact:true}).click();
    await editor.getByTestId('surface-close-button').click();
    const tray=page.getByTestId('drawing-objects-tray');await expect(tray).toBeVisible();
    const rows=await action(page,'objects',{mapId:docs[1].mapId});const id=rows.rows[0].id;
    const row=tray.locator('.tray-row').filter({hasText:'Über <b>plain text</b>'});
    await row.getByRole('button',{name:'Edit object in map',exact:true}).click();
    const before=await action(page,'read',{mapId:docs[1].mapId,objectId:id});
    await page.mouse.move(label.x,label.y);await page.mouse.down();await page.mouse.move(label.x+45,label.y+30,{steps:8});await page.mouse.up();
    await expect(async()=>{expect(JSON.parse((await action(page,'read',{mapId:docs[1].mapId,objectId:id})).text).revision).toBeGreaterThan(JSON.parse(before.text).revision);}).toPass({timeout:10000});
    await tray.getByRole('button',{name:'Undo drawing edit',exact:true}).click();
    await expect.poll(async()=>JSON.parse((await action(page,'read',{mapId:docs[1].mapId,objectId:id})).text).feature).toEqual(JSON.parse(before.text).feature);
    await page.mouse.click(label.x,label.y);
    await toolbar.getByTestId('drawing-options-toggle').click();
    await page.getByRole('button',{name:'Move selected vertex',exact:true}).click();
    await expect(toolbar).toContainText('Click the vertex destination');
    await page.mouse.click(label.x+60,label.y+25);
    await expect(async()=>{expect(JSON.parse((await action(page,'read',{mapId:docs[1].mapId,objectId:id})).text).feature.geometry).not.toEqual(JSON.parse(before.text).feature.geometry);}).toPass();
    await tray.getByRole('button',{name:'Undo drawing edit',exact:true}).click();
    await expect(async()=>{expect(JSON.parse((await action(page,'read',{mapId:docs[1].mapId,objectId:id})).text).feature).toEqual(JSON.parse(before.text).feature);}).toPass();
    await row.getByRole('button',{name:'Delete object',exact:true}).click();await expect(row.getByRole('button',{name:'Delete object',exact:true})).toHaveCount(0);
    await expect(tray.getByRole('grid',{name:'Workspace objects'})).toBeFocused();
    await tray.getByRole('button',{name:'Undo drawing edit',exact:true}).click();await expect(row.getByRole('button',{name:'Delete object',exact:true})).toHaveCount(1);
    await toolbar.getByTestId('drawing-options-toggle').click();
    await page.getByRole('button',{name:'Save options…',exact:true}).click();
    await dialog.getByLabel('Name',{exact:true}).fill('Unified survey');
    await dialog.getByLabel('One unified GeoJSON document').check();
    await dialog.getByTestId('drawing-save-confirm').click();await expect(dialog).toBeHidden();
    docs=(await action(page,'list')).documents;expect(docs).toHaveLength(1);expect((await action(page,'objects',{mapId:docs[0].mapId})).total).toBe(2);
    await page.mouse.move(0,0);await page.screenshot({path:testInfo.outputPath('drawing-workspace.png'),fullPage:true});
    expect(errors).toEqual([]);expect(requests).toEqual([]);
    if (browserName === 'chromium') await captureDocsScreenshotWithLabels(page, 'docs/screenshots/drawing-workspace.png', [
        {locator:toolbar.getByTestId('drawing-tool-select'),through:toolbar.getByTestId('drawing-tool-annotation'),label:'Drawing tools and direct editing',placement:'left'},
        {locator:toolbar.getByLabel('Snap to geometry',{exact:true}),through:toolbar.getByTestId('drawing-options-toggle'),label:'Snapping, color and measurement presets',at:[700,115]},
        {locator:page.getByTestId('drawing-objects-tray'),label:'Objects, document selection and undo',placement:'left'}
    ], {strict:true});
});

test('preserves polar data and renders a vertical planar polygon with native measurements',async({page},testInfo)=>{
    await start(page);
    const workspace=await action(page,'workspace',{action:'new'}),mapId=workspace.activeId;
    const viewId=await page.evaluate(()=>window.ebDebug.viewSettings.viewIdAt(0));
    await page.evaluate(()=>{
        window.ebDebug.viewSettings.mode2dState.next(0,false);
        window.ebDebug.setCamera(0,JSON.stringify({position:[.02*Math.PI/180,0,30000],orientation:{heading:0,pitch:-Math.PI/6,roll:0}}));
    });
    const points=await page.evaluate(()=>{
        const core=window.ebDebug.coreLib();const plane={origin:[0,0,0],u:[0,1,0],v:[1,0,0]};
        return {plane,points:[[0,0],[5000,0],[5000,5000],[0,5000]].map(position=>JSON.parse(core.drawingPlane(JSON.stringify({action:'global',plane,position}))))};
    });
    let revision=(await action(page,'objects',{mapId})).revision;
    await action(page,'edit',{mapId,revision,operations:[{type:'insert',feature:{type:'Feature',geometry:null,properties:{color:'#c04020'},'erdblick:drawing':{version:1,kind:'polygon',space:'3d',...points,measurements:{area:true,perimeter:true}}}}]});
    let objects=await action(page,'objects',{mapId});const object=JSON.parse((await action(page,'read',{mapId,objectId:objects.rows[0].id})).text);
    expect(object.metrics.areaSquareMeters).toBeCloseTo(25000000,0);
    await action(page,'presentation',{action:'select',viewId,mapId,objectId:object.id});
    await expect.poll(()=>page.evaluate(()=>window.ebDebug.subsetRenderPresentation().labels)).toBeGreaterThanOrEqual(1);
    await page.mouse.move(0,0);await page.screenshot({path:testInfo.outputPath('drawing-vertical-plane.png'),fullPage:true});
    const bounds=(await page.locator('canvas').first().boundingBox())!;
    const zoom=Math.log2(2*Math.PI*6378137/(512*(2*30000*Math.tan(DECK_MAP_FOV_DEGREES*Math.PI/360)/bounds.height)));
    const viewport=createDeckMapViewport({longitude:.02,latitude:0,zoom,pitch:60,bearing:0},bounds.width,bounds.height,false);
    const handle=viewport.project(points.points[3]);
    await page.mouse.move(bounds.x+handle[0],bounds.y+handle[1]);await page.mouse.down();
    await page.mouse.move(bounds.x+handle[0]+25,bounds.y+handle[1]-15,{steps:5});await page.mouse.up();
    await expect(async()=>{const changed=JSON.parse((await action(page,'read',{mapId,objectId:object.id})).text);expect(changed.feature['erdblick:drawing'].points[3]).not.toEqual(points.points[3]);}).toPass({timeout:10000});
    const moved=JSON.parse((await action(page,'read',{mapId,objectId:object.id})).text);
    expect(moved.metrics.areaSquareMeters).toBeGreaterThan(0);
    await action(page,'history',{mapId,direction:'undo'});
    const restored=JSON.parse((await action(page,'read',{mapId,objectId:object.id})).text);
    expect(restored.metrics.areaSquareMeters).toBeCloseTo(25000000,0);
    revision=(await action(page,'objects',{mapId})).revision;
    await action(page,'edit',{mapId,revision,operations:[{type:'insert',feature:{type:'Feature',geometry:null,properties:{},'erdblick:drawing':{version:1,kind:'polyline',space:'2d',points:[[0,89],[90,90]],measurements:{distances:true}}}}]});
    objects=await action(page,'objects',{mapId});const polar=JSON.parse((await action(page,'read',{mapId,objectId:objects.rows[1].id})).text);
    expect(polar.feature['erdblick:drawing'].points[1][1]).toBe(90);expect(polar.metrics.lengthMeters).toBeGreaterThan(100000);
    await expect(page.getByTestId('drawing-objects-tray')).toBeVisible();
});

test('uses drawing actions through real remote MCP and the document WebMCP adapter',async({page,request})=>{
    test.skip(process.env['EB_MAPGET_MCP_LOCAL']!=='1','Requires the local native MCP fixture.');
    await page.addInitScript(()=>{const tools:Record<string,any>={};(window as any).drawingDocumentTools=tools;Object.defineProperty(document,'modelContext',{value:{registerTool:async(tool:any)=>{tools[tool.name]=tool;}}});});
    await start(page);const client=mcpClient(request),label='Drawing integration '+crypto.randomUUID();
    await page.getByTestId('viewer-action-status').click();
    await page.getByLabel('Tab label',{exact:true}).fill(label);await page.getByLabel('Tab label',{exact:true}).press('Tab');
    await expect.poll(async()=>(await client.sessions()).some(session=>session.label===label)).toBe(true);
    const clientId=(await client.sessions()).find(session=>session.label===label)!.clientId;
    await page.getByTestId('viewer-action-status').click();
    const created=await client.call('viewer_drawing_workspace',{clientId,action:'new'});expect(created.isError).not.toBe(true);
    const mapId=created.structuredContent.activeId;
    await expect.poll(()=>page.evaluate(()=>!!(window as any).drawingDocumentTools.viewer_drawing_edit)).toBe(true);
    const objects=await client.call('viewer_drawing_objects',{clientId,mapId});
    const captured=await client.call('viewer_drawing_list',{clientId});
    const result=await page.evaluate(async({mapId,revision})=>(window as any).drawingDocumentTools.viewer_drawing_edit.execute({mapId,revision,operations:[{type:'insert',feature:{type:'Feature',geometry:{type:'Point',coordinates:[0,0]},properties:{name:'Document adapter'}}}]},{signal:new AbortController().signal}),{mapId,revision:objects.structuredContent.revision});
    expect(result.isError).not.toBe(true);
    const read=await client.call('viewer_drawing_read',{clientId,mapId});expect(read.structuredContent.text).toContain('Document adapter');
    const stale=await client.call('viewer_drawing_workspace',{clientId,action:'save',workspace:captured.structuredContent.workspace,name:'Stale save',layout:'one'});
    expect(stale.isError).toBe(true);
    const current=await client.call('viewer_drawing_list',{clientId});
    expect(current.structuredContent.documents.find((doc:any)=>doc.mapId===mapId).saved).toBe(false);
    const text=JSON.stringify({type:'Feature',id:9007199254740991,geometry:{type:'Point',coordinates:[1,2]},properties:{name:'Unicode 🌍\nüber'}});
    const transfer=await client.call('viewer_drawing_transfer',{clientId,action:'begin',name:'Remote Unicode',total:text.length});
    const transferId=transfer.structuredContent.transferId;
    const bad=await client.call('viewer_drawing_transfer',{clientId,action:'append',transferId,offset:1,text});expect(bad.isError).toBe(true);
    await client.call('viewer_drawing_transfer',{clientId,action:'append',transferId,offset:0,text});
    const cancelled=await client.call('viewer_drawing_transfer',{clientId,action:'cancel',transferId});expect(cancelled.structuredContent.outcome).toBe('not_applied');
    expect((await client.call('viewer_drawing_list',{clientId})).structuredContent.total).toBe(current.structuredContent.total);
    const second=await client.call('viewer_drawing_transfer',{clientId,action:'begin',name:'Remote Unicode',total:text.length});
    await client.call('viewer_drawing_transfer',{clientId,action:'append',transferId:second.structuredContent.transferId,offset:0,text});
    const imported=await client.call('viewer_drawing_transfer',{clientId,action:'commit',transferId:second.structuredContent.transferId});
    expect(imported.structuredContent.outcome).toBe('applied');
    expect((await client.call('viewer_drawing_read',{clientId,mapId:imported.structuredContent.mapId})).structuredContent.text).toBe(text);
    expect((await client.call('viewer_drawing_list',{clientId})).structuredContent.activeId).toBe(current.structuredContent.activeId);
});

test('snaps to visible line geometry without requests and updates the per-view scale', async ({page}) => {
    const requests: string[] = [];
    page.on('request', request => {if(/drawing-[0-9a-f]{8}-/.test(request.url()+(request.postData()??'')))requests.push(request.url());});
    await start(page);
    const viewId = await page.evaluate(() => window.ebDebug.viewSettings.viewIdAt(0));
    const target = await action(page,'workspace',{action:'new'}), mapId=target.activeId;
    const revision = (await action(page,'objects',{mapId})).revision;
    await action(page,'edit',{mapId,revision,operations:[{type:'insert',feature:{type:'Feature',geometry:{type:'LineString',coordinates:[[-.2,0,0],[.2,0,0]]},properties:{color:'#ff8400'}}}]});
    await expect.poll(()=>page.evaluate(()=>window.ebDebug.subsetRenderPresentation().highWaterRecords)).toBeGreaterThan(0);
    const created = await action(page,'workspace',{action:'new'});
    await action(page,'tool',{action:'start',mode:'point',viewId,snap:true,snapSegments:true,snapPoints:false,tolerance:12});
    await expect.poll(()=>page.evaluate(()=>{const queue=window.ebDebug.subsetRenderQueue();return queue.queued+queue.inFlight+queue.ready;})).toBe(0);
    await expect.poll(()=>page.evaluate(()=>window.ebDebug.subsetRenderPresentation().activeContributions)).toBeGreaterThanOrEqual(2);
    const bounds=(await page.locator('canvas').first().boundingBox())!;
    await page.mouse.move(bounds.x+bounds.width/2+17,bounds.y+bounds.height/2+5);
    await page.mouse.click(bounds.x+bounds.width/2+17,bounds.y+bounds.height/2+5);
    await expect(page.getByTestId('measurement-points')).toHaveText('1 positions');
    const objects=await action(page,'objects',{mapId:created.activeId});
    const feature=JSON.parse((await action(page,'read',{mapId:created.activeId,objectId:objects.rows[0].id})).text).feature;
    expect(feature.geometry.coordinates[1]).toBeCloseTo(0,7);
    await page.getByRole('button',{name:'Map scale',exact:true}).click();
    await expect(page.getByTestId('map-scale')).toBeVisible();
    await expect(page.getByTestId('map-scale')).toContainText(/m|km/);
    await action(page,'tool',{action:'configure',unit:'miles'});
    await expect(page.getByTestId('map-scale')).toContainText('mi');
    await page.getByRole('button',{name:'Map scale',exact:true}).click();
    await expect(page.getByTestId('map-scale')).toBeHidden();expect(requests).toEqual([]);
});

/** Exercise the semantic inspector using controls; action reads only verify the resulting native data. */
test('edits a plain line through Quick, enables measurements and markers, and splits a selected curve',async({page})=>{
    await start(page);
    const toolbar=page.getByTestId('drawing-toolbar');
    await toolbar.getByTestId('drawing-tool-polyline').click();
    await expect(toolbar.getByTestId('measurement-points')).toHaveText('0 positions');
    const bounds=(await page.locator('canvas').first().boundingBox())!;
    await page.mouse.click(bounds.x+bounds.width*.18,bounds.y+bounds.height*.4);
    await expect(toolbar.getByTestId('measurement-points')).toHaveText('1 positions');
    await page.mouse.click(bounds.x+bounds.width*.25,bounds.y+bounds.height*.43);
    await expect(toolbar.getByTestId('measurement-points')).toHaveText('2 positions');
    await toolbar.getByRole('button',{name:'Finish drawing',exact:true}).click();
    const tray=page.getByTestId('drawing-objects-tray');
    await tray.getByRole('button',{name:'Object properties',exact:true}).click();
    const editor=page.locator('editor-surface[data-editor-kind="drawing"]');
    const state=await action(page,'list'),mapId=state.activeId,id=state.selectedObjectId;
    const read=async()=>{let feature:any;await expect(async()=>{feature=JSON.parse((await action(page,'read',{mapId,objectId:id})).text).feature;}).toPass({timeout:10000});return feature;};
    expect((await read())['erdblick:drawing'].measurements.distances).toBe(false);
    await editor.getByRole('textbox',{name:'Name',exact:true}).fill('Curved survey');
    await editor.getByRole('textbox',{name:'Name',exact:true}).press('Tab');
    await expect.poll(async()=>(await read()).properties.name).toBe('Curved survey');
    await editor.getByRole('checkbox',{name:'Distances',exact:true}).check();
    await expect.poll(async()=>(await read())['erdblick:drawing'].measurements.distances).toBe(true);
    await editor.getByRole('checkbox',{name:'Angles',exact:true}).check();
    await expect.poll(async()=>(await read())['erdblick:drawing'].measurements.angles).toBe(true);
    await editor.getByRole('checkbox',{name:'Interval markers',exact:true}).check();
    await editor.getByRole('combobox',{name:'Object measurement units'}).click();
    await page.getByRole('option',{name:'Miles',exact:true}).click();
    const interval=editor.getByRole('spinbutton',{name:'Interval (mi)',exact:true});
    await interval.fill('0.1');await interval.press('Tab');
    await expect.poll(async()=>(await read())['erdblick:drawing'].measurements.intervalMeters).toBeCloseTo(160.9344,4);
    await editor.getByRole('combobox',{name:'Interval marker style'}).click();await page.getByRole('option',{name:'Ticks',exact:true}).click();
    await expect.poll(async()=>(await read())['erdblick:drawing'].measurements.marker).toBe('tick');
    await editor.getByRole('textbox',{name:'Object color hex'}).fill('#2266cc');
    await editor.getByRole('button',{name:'Apply color',exact:true}).click();
    await expect.poll(async()=>(await read()).properties.color).toBe('#2266cc');
    const vertices=editor.getByRole('treeitem',{name:'Control vertices',exact:true});
    await vertices.focus();await vertices.press('ArrowRight');
    const firstVertex=editor.getByRole('treeitem',{name:'Vertex 1',exact:true});await expect(firstVertex).toBeVisible();
    await vertices.press('ArrowDown');await expect(firstVertex).toBeFocused();
    await firstVertex.press('ArrowRight');
    const longitude=editor.getByRole('treeitem',{name:'Longitude (°)',exact:true}).first();await expect(longitude).toBeVisible();
    await firstVertex.press('ArrowDown');await expect(longitude).toBeFocused();await longitude.press('Enter');
    const coordinate=longitude.getByRole('textbox');await expect(coordinate).toBeFocused();
    const accepted=await coordinate.inputValue();await coordinate.fill('invalid temporary input');await coordinate.press('Escape');
    await expect(coordinate).toHaveValue(accepted);await expect(longitude).toBeFocused();
    const selectSegment=editor.getByRole('button',{name:'Select segment after vertex 1',exact:true});
    await longitude.press('Tab');await expect(selectSegment).toBeFocused();await selectSegment.press('Enter');
    await editor.getByRole('button',{name:'Add curve handles',exact:true}).click();
    await expect.poll(async()=>Object.keys((await read())['erdblick:drawing'].curves??{}).length).toBe(1);
    await editor.getByRole('button',{name:'Insert after',exact:true}).first().click();
    await expect.poll(async()=>(await read())['erdblick:drawing'].points.length).toBe(3);
    expect(Object.keys((await read())['erdblick:drawing'].curves)).toHaveLength(2);
    await editor.getByRole('tab',{name:'Advanced',exact:true}).click();
    expect((await editor.locator('.cm-editor').boundingBox())!.height).toBeGreaterThan(150);
    await editor.getByRole('tab',{name:'Quick',exact:true}).click();
    await tray.getByRole('button',{name:'Undo drawing edit',exact:true}).click();
    await expect.poll(async()=>(await read())['erdblick:drawing'].points.length).toBe(2);
});

/** Mode and plane setup are ordinary UI steps, not debug geometry construction. */
test('guides 3D plane setup, pauses on a mode switch, and cancels an empty annotation',async({page})=>{
    await start(page);
    const toolbar=page.getByTestId('drawing-toolbar');
    await page.getByRole('button',{name:'3D',exact:true}).click();
    await toolbar.getByTestId('drawing-tool-polygon').click();
    await toolbar.getByTestId('drawing-options-toggle').click();
    await page.getByRole('button',{name:'Horizontal plane · one anchor',exact:true}).click();
    await expect(toolbar.getByTestId('drawing-status')).toContainText('Choose plane origin');
    const bounds=(await page.locator('canvas').first().boundingBox())!;
    const a={x:bounds.x+bounds.width*.2,y:bounds.y+bounds.height*.5};
    await page.mouse.click(a.x,a.y);
    await expect(toolbar.getByTestId('drawing-status')).toContainText('Placing polygon · 3D');
    await page.mouse.click(a.x,a.y);await page.mouse.click(a.x+80,a.y);await page.mouse.click(a.x+40,a.y-60);
    await expect(toolbar.getByTestId('measurement-points')).toHaveText('3 positions');
    await page.getByRole('button',{name:'2D',exact:true}).click();
    await expect(toolbar).toContainText('Paused · choose a matching 3D view');
    await expect(toolbar.getByRole('button',{name:'Finish drawing',exact:true})).toHaveCount(0);
    const docs=await action(page,'list');const objects=await action(page,'objects',{mapId:docs.activeId});
    expect(objects.rows[0].space).toBe('3d');
    await toolbar.getByTestId('drawing-tool-annotation').click();
    await page.mouse.click(a.x,a.y+100);
    const input=toolbar.getByRole('textbox',{name:'Text',exact:true});await expect(input).toBeFocused();
    await input.fill('Uncommitted label');await input.press('Escape');
    await expect(input).toHaveCount(0);
    await expect.poll(async()=>(await action(page,'objects',{mapId:docs.activeId})).total).toBe(1);
    await page.getByRole('button',{name:'3D',exact:true}).click();await toolbar.getByTestId('drawing-tool-polygon').click();
    await toolbar.getByTestId('drawing-options-toggle').click();await page.getByRole('button',{name:'Three-anchor plane',exact:true}).click();
    const p={x:bounds.x+bounds.width*.35,y:bounds.y+bounds.height*.62};
    await page.mouse.click(p.x,p.y);await page.mouse.click(p.x+100,p.y);
    await expect(toolbar.getByTestId('drawing-status')).toContainText('Choose third plane anchor');
    await toolbar.getByRole('button',{name:'Undo plane anchor',exact:true}).click();
    await expect(toolbar.getByTestId('drawing-status')).toContainText('Choose second plane anchor');
    await page.mouse.click(p.x+100,p.y);
    await toolbar.getByTestId('drawing-options-toggle').click();
    const elevation=page.getByTestId('drawing-options').getByRole('spinbutton',{name:'Elevation (m)',exact:true});
    await elevation.fill('2000');await elevation.press('Tab');await elevation.press('Escape');
    await page.mouse.click(p.x,p.y+80);
    await expect(toolbar.getByTestId('drawing-status')).toContainText('Placing polygon');
    await page.mouse.click(p.x,p.y);await page.mouse.click(p.x+100,p.y);await page.mouse.click(p.x,p.y+80);
    await toolbar.getByRole('button',{name:'Finish drawing',exact:true}).click();
    await expect(async()=>{
        const rows=await action(page,'objects',{mapId:docs.activeId});expect(rows.total).toBe(2);
        const target={mapId:docs.activeId,objectId:rows.rows[1].id,revision:rows.revision};
        const object=(await action(page,'branch',target)).branch.object;
        expect(object.feature['erdblick:drawing'].plane).toBeDefined();expect(object.metrics.areaSquareMeters).toBeGreaterThan(0);
        expect(Number((await action(page,'branch',{...target,path:'/erdblick:drawing/points/2/2'})).branch.text)).toBeGreaterThan(1000);
    }).toPass({timeout:15000});
});

/** A large single feature must not be fetched in full merely to inspect a selected branch. */
test('pages a large single geometry with bounded replies and exact integer property edits',async({page},testInfo)=>{
    await page.addInitScript(()=>{
        (window as any).drawingBranchBytes=[];
        const post=Worker.prototype.postMessage;
        Worker.prototype.postMessage=function(message:any,...rest:any[]){
            if(message?.operation?.type==='branch'){
                const worker=this,listener=(event:MessageEvent)=>{
                    if(event.data?.id!==message.id)return;
                    worker.removeEventListener('message',listener);
                    (window as any).drawingBranchBytes.push(new TextEncoder().encode(JSON.stringify(event.data)).length);
                };
                worker.addEventListener('message',listener);
            }
            return (post as any).apply(this,[message,...rest]);
        };
    });
    await page.route(/\/sources(?:\?.*)?$/,async route=>route.fulfill({response:await route.fetch(),json:[]}));
    await navigateToStateSnapshotRoot(page);
    const coordinates=Array.from({length:10001},(_,i)=>[i/1000000,(i%2)/1000000]);
    const text=JSON.stringify({type:'Feature',geometry:{type:'LineString',coordinates},properties:{name:'Dense path',precise:'EXACT_INTEGER'}}).replace('"EXACT_INTEGER"','9007199254740993');
    const menu=await openMainMenu(page,'File');await menu.getByRole('menuitem',{name:/New GeoJSON$/}).click();
    await page.getByLabel('Choose drawing file').setInputFiles({name:'Dense path.geojson',mimeType:'application/geo+json',buffer:Buffer.from(text)});
    const editor=page.locator('editor-surface[data-editor-kind="drawing"]');
    await editor.getByRole('button',{name:/Dense path/}).click();
    await editor.getByRole('button',{name:/^Geometry · parts and rings/}).click();
    await editor.getByRole('button',{name:/^Vertices/}).click();
    await expect(editor.getByRole('treeitem',{name:/^Vertex \d+$/})).toHaveCount(50);
    await editor.getByRole('button',{name:'Next page',exact:true}).click();
    await expect(editor.getByRole('treeitem',{name:'Vertex 51',exact:true})).toBeVisible();
    await expect(editor.getByRole('treeitem',{name:'Vertex 1',exact:true})).toHaveCount(0);
    await expect(editor.getByRole('treeitem',{name:/^Vertex \d+$/})).toHaveCount(50);
    await editor.getByRole('button',{name:/^Properties/}).click();
    const precise=editor.getByRole('textbox',{name:'precise',exact:true});
    await expect(precise).toHaveValue('9007199254740993');
    await precise.fill('9007199254740995');await precise.press('Tab');
    const docs=await action(page,'list'),mapId=docs.activeId,id=docs.selectedObjectId;
    await expect(async()=>{const objects=await action(page,'objects',{mapId});expect((await action(page,'branch',{mapId,objectId:id,revision:objects.revision,path:'/properties/precise'})).branch.text).toBe('9007199254740995');}).toPass();
    await editor.getByRole('button',{name:'Value options for precise',exact:true}).click();
    await editor.getByRole('combobox',{name:'precise value type',exact:true}).click();await page.getByRole('option',{name:'string',exact:true}).click();
    await editor.getByRole('group',{name:'precise value options',exact:true}).getByRole('button',{name:'Apply type',exact:true}).click();
    await expect(async()=>{const objects=await action(page,'objects',{mapId});expect((await action(page,'branch',{mapId,objectId:id,revision:objects.revision,path:'/properties/precise'})).branch.text).toBe('"9007199254740995"');}).toPass();
    await editor.getByRole('button',{name:'Value options for Properties',exact:true}).click();
    await editor.getByRole('textbox',{name:'New property in Properties',exact:true}).fill('new/key');
    await editor.getByRole('group',{name:'Properties value options',exact:true}).getByRole('button',{name:'Add property',exact:true}).click();
    const property=editor.getByRole('treeitem',{name:'new/key',exact:true});await expect(property).toBeVisible();
    await property.getByRole('button',{name:'Value options for new/key',exact:true}).click();await property.getByRole('button',{name:'Remove value',exact:true}).click();
    await expect(property).toHaveCount(0);
    const replies=await page.evaluate(()=>(window as any).drawingBranchBytes as number[]);
    expect(replies.length).toBeGreaterThan(3);expect(Math.max(...replies)).toBeLessThan(32768);
    await testInfo.attach('large-feature-branch-qualification',{body:JSON.stringify({sourceBytes:Buffer.byteLength(text),maximumReplyBytes:Math.max(...replies),mountedVertices:50}),contentType:'application/json'});
});
