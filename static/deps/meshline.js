// Copyright (c) Navigation Data Standard e.V. - See "LICENSE" file.

"use strict";

import {MeshBasicMaterial, ShaderLib, UniformsUtils} from "./three.js";

export class MeshLineMaterial extends MeshBasicMaterial
{
    constructor(params)
    {
        super(params);

        this.uniforms = UniformsUtils.clone(ShaderLib.basic.uniforms);

        this.vertexShader = `
        #include <common>
        #include <uv_pars_vertex>
        #include <uv2_pars_vertex>
        #include <envmap_pars_vertex>
        #include <color_pars_vertex>
        #include <fog_pars_vertex>
        #include <morphtarget_pars_vertex>
        #include <skinning_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        #include <clipping_planes_pars_vertex>
    
        const float InverseZoomFactor = 360.;
    
        void main()
        {
            // We do not allow lines to shrink when zooming in, only to grow when zooming out.
            float inverseZoom = max(
                min(
                    2e3,
                    InverseZoomFactor/max(abs(projectionMatrix[0][0]), abs(projectionMatrix[1][1]))),
                1.);
            
            #include <uv_vertex>
            #include <uv2_vertex>
            
            #ifdef USE_MAP
                vUv.y /= inverseZoom;
            #endif
            
            // #include <color_vertex>
            vColor = color;
            
            #include <skinbase_vertex>
            #if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )
                #include <beginnormal_vertex>
                #include <morphnormal_vertex>
                #include <skinbase_vertex>
                #include <skinnormal_vertex>
                #include <defaultnormal_vertex>
            #endif
            #include <begin_vertex>
            
            transformed.xy += normal.xy * inverseZoom;
            
            #include <morphtarget_vertex>
            #include <skinning_vertex>
            #include <project_vertex>
            #include <logdepthbuf_vertex>
            #include <worldpos_vertex>
            #include <clipping_planes_vertex>
            #include <envmap_vertex>
            #include <fog_vertex>
        }
        `;

        this.fragmentShader = ShaderLib.basic.fragmentShader;
        this.type = 'MeshLineMaterial';
    }

}
