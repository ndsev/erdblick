import {closestVisibleProjectedSegmentPoint} from './navigation/erdblick-navigation-anchor.util';
import type {Viewport} from '@deck.gl/core';
import type {DrawingPlane, DrawingPosition} from '../../drawing/drawing.model';
import {coreLib} from '../../integrations/wasm.adapter';

/** Invert the actual Mercator projection on a physical plane, not an ECEF screen ray. */
export function drawingPlanePosition(view: Pick<Viewport, 'project'>, screen: [number, number], plane: DrawingPlane): DrawingPosition | undefined {
    const project = (x: number, y: number): {position: DrawingPosition; screen: number[]} => {
        const position: DrawingPosition = JSON.parse(coreLib.drawingPlane(JSON.stringify({action: 'global', plane, position: [x, y]})));
        return {position, screen: view.project(position as number[])};
    };
    let x = 0, y = 0;
    for (let iteration = 0; iteration < 24; ++iteration) {
        const point = project(x, y), errorX = screen[0] - point.screen[0], errorY = screen[1] - point.screen[1];
        if (Math.hypot(errorX, errorY) < .1) return point.position;
        const step = Math.max(1, Math.hypot(x, y) * 1e-5);
        const dx = project(x + step, y).screen, dy = project(x, y + step).screen;
        const a = (dx[0] - point.screen[0]) / step, b = (dy[0] - point.screen[0]) / step;
        const c = (dx[1] - point.screen[1]) / step, d = (dy[1] - point.screen[1]) / step, det = a*d-b*c;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return undefined;
        const moveX = (d*errorX-b*errorY)/det, moveY = (a*errorY-c*errorX)/det;
        if (!Number.isFinite(moveX) || !Number.isFinite(moveY) || Math.hypot(moveX, moveY) > 2e7) return undefined;
        x += moveX; y += moveY;
    }
    return undefined;
}

/** Bounded logical geometry from one already-rendered native subset row. */
export interface DrawingSnapPart {points: DrawingPosition[]; line: boolean; closed: boolean;}
export interface DrawingSnapCandidate {position: DrawingPosition; key: string; score: number;}

/** Refine a broad-phase pick against original geometry; vertices get a small preference. */
export function drawingSnapCandidate(view: Viewport, screen: [number, number], parts: DrawingSnapPart[], key: string,
    options: {snapPoints: boolean; snapSegments: boolean; tolerance: number; excluded?:DrawingPosition; constrain?:(position:DrawingPosition)=>DrawingPosition}, previous?: string): DrawingSnapCandidate | undefined {
    let best: DrawingSnapCandidate | undefined;
    const offer = (position: DrawingPosition, id: string, vertex: boolean) => {
        const pixel = view.project(position as number[]);
        if(options.constrain){const constrained=view.project(options.constrain(position) as number[]);if(Math.hypot(pixel[0]-constrained[0],pixel[1]-constrained[1])>.5)return;}
        const distance = Math.hypot(pixel[0]-screen[0],pixel[1]-screen[1]);
        if (!Number.isFinite(distance) || distance > options.tolerance) return;
        const score = distance - (vertex ? 1.5 : 0) - (id === previous ? 2 : 0);
        if (!best || score < best.score || score === best.score && id < best.key) best = {position, key: id, score};
    };
    parts.forEach((part, partIndex) => {
        const points = part.points;
        const excluded=(point:DrawingPosition)=>options.excluded && point.every((value,axis)=>Math.abs((value??0)-(options.excluded![axis]??0))<1e-9);
        for (let index = 0; index < points.length; ++index) {
            if (options.snapPoints && !excluded(points[index])) offer(points[index], key+':'+partIndex+':v'+index, true);
            if (!part.line || !options.snapSegments || excluded(points[index]) || excluded(points[(index+1)%points.length]) || (!part.closed && index + 1 === points.length)) continue;
            const next = points[(index+1)%points.length], first = view.projectPosition(points[index] as number[]), second = view.projectPosition(next as number[]);
            const candidate = closestVisibleProjectedSegmentPoint(view.pixelProjectionMatrix, first, second, screen);
            if (candidate) {
                // A perspective screen fraction is not the geographic interpolation parameter.
                // Refine it against projected source positions; this only chooses an interaction target.
                const at=(t:number):DrawingPosition=>[points[index][0]+(next[0]-points[index][0])*t,points[index][1]+(next[1]-points[index][1])*t,(points[index][2]??0)+((next[2]??0)-(points[index][2]??0))*t];
                const distance=(t:number)=>{const pixel=view.project(at(t) as number[]);return Math.hypot(pixel[0]-screen[0],pixel[1]-screen[1]);};
                let left=0,right=1;
                for(let iteration=0;iteration<24;++iteration){const a=left+(right-left)/3,b=right-(right-left)/3;if(distance(a)<distance(b))right=b;else left=a;}
                const t = (left+right)/2; offer([
                points[index][0]+(next[0]-points[index][0])*t, points[index][1]+(next[1]-points[index][1])*t,
                (points[index][2]??0)+((next[2]??0)-(points[index][2]??0))*t
            ], key+':'+partIndex+':s'+index, false); }
        }
    });
    return best;
}
