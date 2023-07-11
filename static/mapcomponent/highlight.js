"use strict";

import {
    ShaderMaterial,
    Mesh,
    PlaneGeometry,
    Scene,
    Vector3
} from "../deps/three.js"

/**
 * Class which encapsulates a render-pass, that highlights certain map elements:
 * - Map elements that are currently being hovered over by the user.
 * - Selected map elements
 */
export class HighlightPass
{
// private:

    constructor(platform, framebuffers)
    {
        let vertexShaderSource = `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position, 1.0);
        }
        `;

        let fragShaderCommon = `
        varying vec2 vUv;
        uniform sampler2D framebufferVisual;
        uniform sampler2D framebufferPicking;
        uniform bool showPickingTexture;
        uniform float highlightIntensityHover;
        
        uniform vec3 highlightIdHover;            // Full id of the hovered element
        uniform vec3 highlightGroupMaskHover;     // Group mask; {0} or {0x1ffff}
        uniform vec3 highlightGroupMaskHoverInv;  // 1/(mask+1), so {1} or {1/0x20000}. Needed for fp modulo.
        uniform vec3 highlightGroupIdHover;       // ID of the hovered group. -1 (no group) or greater.
        
        uniform vec3 highlightIdSeln;            // Full id of the selected element
        uniform vec3 highlightGroupMaskSeln;     // Group mask; {0} or {0x1ffff}
        uniform vec3 highlightGroupMaskSelnInv;  // 1/(mask+1), so {1} or {1/0x20000}. Needed for fp modulo.
        uniform vec3 highlightGroupIdSeln;       // ID of the hovered group. -1 (no group) or greater.
        
        const vec3 v1 = vec3(1.);
        const vec4 nullHighlight = vec4(.0);
        const vec4 rgba888XToF = vec4(
        255.,      // 0x0000ff
        65280.,    // 0x00ff00
        16711680., // 0xff0000
        0);
        
        #define NUM_PROXIMITY_SAMPLE_VECS 7
        
        float pickingIdAtUv(in vec2 uv) {
            return dot(texture2D(framebufferPicking, uv), rgba888XToF);
        }
        
        void pickingIdsAroundsUv(inout vec3 result[NUM_PROXIMITY_SAMPLE_VECS])
        {
            vec2 duv = fwidth(vUv);
            vec2 du = vec2(duv.x, 0.);
            vec2 dv = vec2(0., duv.y);
            vec2 du2 = vec2(2. * duv.x, 0.);
            vec2 dv2 = vec2(0., 2. * duv.y);
            
            result[0] = vec3(pickingIdAtUv(vUv-duv),     pickingIdAtUv(vUv-du),   pickingIdAtUv(vUv-du+dv));   // left
            result[1] = vec3(pickingIdAtUv(vUv-dv),      pickingIdAtUv(vUv),      pickingIdAtUv(vUv+dv));      // middle
            result[2] = vec3(pickingIdAtUv(vUv-dv+du),   pickingIdAtUv(vUv+du),   pickingIdAtUv(vUv+duv));     // right
            result[3] = vec3(pickingIdAtUv(vUv-du2-dv),  pickingIdAtUv(vUv-du2),  pickingIdAtUv(vUv-du2+dv));  // left*2
            result[4] = vec3(pickingIdAtUv(vUv+du2-dv),  pickingIdAtUv(vUv+du2),  pickingIdAtUv(vUv+du2+dv));  // right*2
            result[5] = vec3(pickingIdAtUv(vUv-dv2-du),  pickingIdAtUv(vUv-dv2),  pickingIdAtUv(vUv-dv2+du));  // top*2
            result[6] = vec3(pickingIdAtUv(vUv+dv2-du),  pickingIdAtUv(vUv+dv2),  pickingIdAtUv(vUv+dv2+du));  // bottom*2
        }
        
        float pickingIdsMatchId(in vec3 pickingIds, in vec3 matchId)
        {
            return dot(v1, vec3(equal(matchId, pickingIds)));
        }
        
        float pickingIdsMatchGroup(in vec3 pickingIds, in vec3 groupMask, in vec3 groupMaskInv, in vec3 groupId)
        {
            return dot(v1,
                vec3(equal(
                    groupId, floor(fract(
                        pickingIds * groupMaskInv
                    ) * groupMask + .5)
                ))
            );
        }
        
        
        // 
        // Produces a function like this:
        //
        //        maxThreshold
        //        |___________ 1 = minIntensity + oneMinusMinIntensity
        //       /_ _ _ _ _ _  minIntensity
        //  ____|_ _ _ _ _ _ _ 0
        // |    |
        // 0    minThreshold
        //
        float smoothStepIntensity(in float rawIntensity)
        {
            const float minThreshold = .5/(float(NUM_PROXIMITY_SAMPLE_VECS) * 3.);
            const float maxThreshold = .4;
            const float minIntensity = .5;
            const float oneMinusMinIntensity = 1. - minIntensity;
            return mix(
                .0,
                minIntensity + smoothstep(minThreshold, maxThreshold, rawIntensity) * oneMinusMinIntensity,
                step(minThreshold, rawIntensity));
        }
        
        float highlightIntensity(
            in vec3 pickingIds[NUM_PROXIMITY_SAMPLE_VECS],
            in vec3 highlightId,
            in vec3 groupMask,
            in vec3 groupMaskInv,
            in vec3 groupId,
            out float matchedPixels)
        {
            matchedPixels = 0.;
            
            if (highlightId.x > 0.)
            {
                const float numPossibleMatchesInv = 1./(float(NUM_PROXIMITY_SAMPLE_VECS) * 3.);
                
                float matchedPixelsExact = smoothStepIntensity(numPossibleMatchesInv * (
                    pickingIdsMatchId(pickingIds[0], highlightId) +
                    pickingIdsMatchId(pickingIds[1], highlightId) +
                    pickingIdsMatchId(pickingIds[2], highlightId) +
                    pickingIdsMatchId(pickingIds[3], highlightId) +
                    pickingIdsMatchId(pickingIds[4], highlightId) +
                    pickingIdsMatchId(pickingIds[5], highlightId) +
                    pickingIdsMatchId(pickingIds[6], highlightId)
                ));
                
                float matchGroup = float(groupMask.x > .0); // matchGroup intensity dilution is reduced by .5
                float matchedPixelsGroup = smoothStepIntensity(matchGroup * numPossibleMatchesInv * (
                    pickingIdsMatchGroup(pickingIds[0], groupMask, groupMaskInv, groupId) +
                    pickingIdsMatchGroup(pickingIds[1], groupMask, groupMaskInv, groupId) +
                    pickingIdsMatchGroup(pickingIds[2], groupMask, groupMaskInv, groupId) +
                    pickingIdsMatchGroup(pickingIds[3], groupMask, groupMaskInv, groupId) +
                    pickingIdsMatchGroup(pickingIds[4], groupMask, groupMaskInv, groupId) +
                    pickingIdsMatchGroup(pickingIds[5], groupMask, groupMaskInv, groupId) +
                    pickingIdsMatchGroup(pickingIds[6], groupMask, groupMaskInv, groupId)
                ));
                
                matchedPixels = max(matchedPixelsExact, matchedPixelsGroup);
                return min(1., (matchedPixelsExact + matchedPixelsGroup)/(1. + matchGroup * .3));
            }
            return .0;
        }
        
        float edgeFilter(in float intensity) {
            return smoothstep(0., 1., (.5 - abs(.5 - intensity)) * 2.);
        }
        `;

        let fragShaderSourceBackground = fragShaderCommon + `
        void main()
        {
            if (showPickingTexture)
                gl_FragColor = vec4(texture2D(framebufferPicking, vUv).rgb, 1.);
            else
                gl_FragColor = vec4(texture2D(framebufferVisual, vUv).rgb, 1.);
        }
        `;

        let fragShaderSourceHover = fragShaderCommon + `
        void main()
        {
            vec3 pickingIds[NUM_PROXIMITY_SAMPLE_VECS];
            pickingIdsAroundsUv(pickingIds);
                
            float hoverHighlightCoverage = .0;
            float hoverHighlight = highlightIntensity(
                pickingIds,
                highlightIdHover,
                highlightGroupMaskHover,
                highlightGroupMaskHoverInv,
                highlightGroupIdHover,
                hoverHighlightCoverage);
                
            gl_FragColor = vec4(0., 1., 1., 1.) * hoverHighlight * .4 * highlightIntensityHover;
        }
        `;

        let fragShaderSourceSelection = fragShaderCommon + `
        void main()
        {
            vec3 pickingIds[NUM_PROXIMITY_SAMPLE_VECS];
            pickingIdsAroundsUv(pickingIds);
                
            float selnHighlightCoverage = .0;
            float selnHighlight = highlightIntensity(
                pickingIds,
                highlightIdSeln,
                highlightGroupMaskSeln,
                highlightGroupMaskSelnInv,
                highlightGroupIdSeln,
                selnHighlightCoverage);
                
            gl_FragColor = vec4(1., 0., 0., .6) * selnHighlight;
        }
        `;

        //

        function makeHighlightShaderMaterial(fragShaderSource) {
            let result = new ShaderMaterial({
                uniforms: {
                    framebufferVisual:          { type: "t",  value: framebuffers.visual.texture },
                    framebufferPicking:         { type: "t",  value: framebuffers.picking.texture },
                    highlightIdHover:           { type: "3f", value: new Vector3() }, // Full id of the hovered element
                    highlightGroupMaskHover:    { type: "3f", value: new Vector3() }, // Group mask; {0} or {0x1ffff}
                    highlightGroupMaskHoverInv: { type: "3f", value: new Vector3() }, // 1/(mask+1), so {1} or {1/0x20000}. Needed for fp modulo.
                    highlightGroupIdHover:      { type: "3f", value: new Vector3() }, // ID of the hovered group. -1 (no group) or greater.
                    highlightIdSeln:            { type: "3f", value: new Vector3() }, // Full id of the selected element
                    highlightGroupMaskSeln:     { type: "3f", value: new Vector3() }, // Group mask; {0} or {0x1ffff}
                    highlightGroupMaskSelnInv:  { type: "3f", value: new Vector3() }, // 1/(mask+1), so {1} or {1/0x20000}. Needed for fp modulo.
                    highlightGroupIdSeln:       { type: "3f", value: new Vector3() }, // ID of the hovered group. -1 (no group) or greater.
                    highlightIntensityHover:    { type: "f", value: 0 },
                    showPickingTexture:         { type: "b",  value: false }
                },
                vertexShader: vertexShaderSource,
                fragmentShader: fragShaderSource,
                depthWrite: false,
                depthTest: false
            });
            result.transparent = true;
            result.extensions.derivatives = true;
            return result;
        }

        //

        function createRenderPass(shaderMaterial) {
            let quad = new Mesh(new PlaneGeometry(2, 2), shaderMaterial);
            quad.frustumCulled = false;
            let scene = new Scene();
            scene.add(quad);
            return {scene: scene, mat: shaderMaterial};
        }

        //

        this.background = createRenderPass(makeHighlightShaderMaterial(fragShaderSourceBackground));

        //

        this.selection = createRenderPass(makeHighlightShaderMaterial(fragShaderSourceSelection));
        this.hover = createRenderPass(makeHighlightShaderMaterial(fragShaderSourceHover));

        //

        this.materials = [this.selection.mat, this.hover.mat, this.background.mat];
    }

    setShowPickingScene(show) {
        this.materials.forEach((mat)=>{mat.uniforms.showPickingTexture.value = show});
    };

    /// ID must be 0rgba integer.
    setHoveredHighlightId(id, group, groupMask, intensity) {
        let invGroupMask = 1./(groupMask+1.);
        this.hover.mat.uniforms.highlightIdHover.value = new Vector3(id, id, id);
        this.hover.mat.uniforms.highlightGroupMaskHover.value = new Vector3(groupMask, groupMask, groupMask);
        this.hover.mat.uniforms.highlightGroupMaskHoverInv.value = new Vector3(invGroupMask, invGroupMask, invGroupMask);
        this.hover.mat.uniforms.highlightGroupIdHover.value = new Vector3(group, group, group);
        this.hover.mat.uniforms.highlightIntensityHover.value = intensity;
    }

    /// ID must be 0rgba integer. Returns true if id has changed and redraw is necessary.
    setSelectedHighlightId(id, group, groupMask) {
        let invGroupMask = 1./(groupMask+1.);
        if (this.selection.mat.uniforms.highlightIdSeln.value.x !== id) {
            this.selection.mat.uniforms.highlightIdSeln.value = new Vector3(id, id, id);
            this.selection.mat.uniforms.highlightGroupMaskSeln.value = new Vector3(groupMask, groupMask, groupMask);
            this.selection.mat.uniforms.highlightGroupMaskSelnInv.value = new Vector3(invGroupMask, invGroupMask, invGroupMask);
            this.selection.mat.uniforms.highlightGroupIdSeln.value = new Vector3(group, group, group);
            return true;
        }
        return false;
    };

    matchesSelectedHighlightId(id, group, groupMask) {
        return (
            (id === this.selection.mat.uniforms.highlightIdSeln.value.x) ||
            (groupMask && group === this.selection.mat.uniforms.highlightGroupIdSeln.value.x));
    }
}
