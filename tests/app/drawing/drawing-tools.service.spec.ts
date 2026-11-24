import '@angular/compiler';
import {describe, expect, it} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
import {coreLib} from '../../../app/integrations/wasm.adapter';
import {drawingPlanePosition, drawingSnapCandidate} from '../../../app/mapview/deck/deck-drawing.util';
import {EditorService} from '../../../app/editor/editor.service';

describe('Drawing physical projection and shared history', () => {
    it('inverts the actual pitched Mercator camera on horizontal, tilted and vertical planes', () => {
        const origin = [11,48,100];
        const horizontal = JSON.parse(coreLib.drawingPlane(JSON.stringify({action:'horizontal',origin})));
        const up = [horizontal.u[1]*horizontal.v[2]-horizontal.u[2]*horizontal.v[1],horizontal.u[2]*horizontal.v[0]-horizontal.u[0]*horizontal.v[2],horizontal.u[0]*horizontal.v[1]-horizontal.u[1]*horizontal.v[0]];
        const view = new WebMercatorViewport({width:1200,height:800,longitude:11,latitude:48,zoom:16,pitch:60,bearing:20});
        for (const v of [horizontal.v,up,horizontal.v.map((n:number,i:number)=>(n+up[i])/Math.sqrt(2))]) {
            const plane = {...horizontal,v};
            const expected = JSON.parse(coreLib.drawingPlane(JSON.stringify({action:'global',plane,position:[25,30]})));
            const screen = view.project(expected), actual = drawingPlanePosition(view,[screen[0],screen[1]],plane);
            expect(actual).toBeDefined();
            const local = JSON.parse(coreLib.drawingPlane(JSON.stringify({action:'local',plane,position:actual})));
            expect(local[0]).toBeCloseTo(25,1); expect(local[1]).toBeCloseTo(30,1);
        }
    });
    it('snaps original points and segments within CSS tolerance, with point preference and stable tie breaking', () => {
        const view = new WebMercatorViewport({width:800,height:600,longitude:0,latitude:0,zoom:15});
        const parts = [{line:true,closed:false,points:[[0,0,50],[.01,0,70]] as [number,number,number][]}];
        const p = view.project([0,0,50]);
        const options = {snapPoints:true,snapSegments:true,tolerance:10};
        expect(drawingSnapCandidate(view,[p[0]+1,p[1]],parts,'a',options)?.key).toContain(':v0');
        const middle = view.project([.005,0,60]);
        const snapped = drawingSnapCandidate(view,[middle[0],middle[1]],parts,'a',options);
        expect(snapped?.key).toContain(':s0'); expect(snapped?.position[2]).toBeCloseTo(60,2);
        expect(drawingSnapCandidate(view,[middle[0],middle[1]+30],parts,'a',options)).toBeUndefined();
        expect(drawingSnapCandidate(view,[middle[0],middle[1]],parts,'a',{...options,snapSegments:false})).toBeUndefined();
    });
    it('retains one undo history before and after a raw editor attaches and preserves CRLF', () => {
        const editors = new EditorService(); editors.createSession({id:'a',source:'one\r\ntwo\r\n',language:'json',preserveLineEndings:true});
        editors.updateSessionSource('a','ONE\r\ntwo\r\n');
        editors.detachState('a'); expect(editors.history('a','undo')).toBe(true);
        expect(editors.getSession('a')!.source$.value).toBe('one\r\ntwo\r\n');
        expect(editors.history('a','redo')).toBe(true);
        expect(editors.getSession('a')!.source$.value).toBe('ONE\r\ntwo\r\n');
        editors.closeSession('a');
    });
});

it('keeps angle constraints and self-vertex exclusions independent of geometry snapping',()=>{
    const view=new WebMercatorViewport({width:800,height:600,longitude:0,latitude:0,zoom:15});
    const options={snapPoints:true,snapSegments:true,tolerance:12};
    const points:[[number,number,number],[number,number,number],[number,number,number]]=[[0,0,0],[.001,0,0],[.002,.001,0]];
    const parts=[{line:true,closed:false,points}];
    const pixel=view.project(points[1]);
    expect(drawingSnapCandidate(view,[pixel[0],pixel[1]],parts,'a',{...options,excluded:points[0]})?.key).toContain(':v1');
    const first=view.project(points[0]);
    expect(drawingSnapCandidate(view,[first[0],first[1]],parts,'a',{...options,excluded:points[0]})).toBeUndefined();
    expect(drawingSnapCandidate(view,[pixel[0],pixel[1]],parts,'a',{...options,constrain:p=>[p[0],p[1]+.01,p[2]]})).toBeUndefined();
});
