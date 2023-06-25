"use strict";

import {
    ShaderLib,
    ShaderChunk,
    Vector2,
    Matrix3,
    Vector3,
    ShaderMaterial,
    TextureLoader,
    RepeatWrapping,
    BufferGeometry,
    BufferAttribute,
    Sphere,
    Mesh,
    DataTexture,
    RGBAFormat,
    UnsignedShort4444Type,
    LinearFilter,
    AlphaFormat,
    UnsignedByteType
} from "../deps/three.js"
import {MapViewerConst} from "./consts.js";
import {uvTransform} from "./utils.js";

/** Scalable Sphere that comes with LOD capabilities. */

export class Globe
{
    constructor(platform, framebuffers, capabilities, viewport)
    {
        this.platform = platform;
        this.terrain = {
            phiMin: .0,
            thetaMin: .0,
            phiMax: .0,
            thetaMax: .0,
            phiLength: .0,
            thetaLength: .0,
            width: 256,
            height: 256,
        };
        this.terrainExcentricityValue = 1.;
        this.heightmapData = null;
        this.lightmapData = null;

        this.gridLevelValue = -1;
        this.meshVisual = null;
        this.materialVisual = null;
        this.materialPicking = null;
        this.vp = viewport;

        ShaderLib.globeVisual = {
            vertexShader : `
                #include <common>
                #include <filter_uv_pars>
        
                uniform vec2 polarOffset;
                uniform vec2 polarDimensions;
                uniform vec3 vpTopLeft;
                uniform vec3 vpBottomLeft;
                uniform vec3 vpTop;
                uniform vec3 vpBottom;
                uniform vec3 vpHeight;
                uniform sampler2D heightmapTex;
                uniform sampler2D lightmapTex;
                uniform float terrainExcentricity;
                uniform mat3 viewportToTerrainUv;
                uniform mat3 tileToViewportUv;
                
                uniform float cameraViewRadius;
                uniform vec2 cameraPos;
        
                varying highp vec2 globeUv;
                varying highp vec2 tileUv;
                varying float light;
                varying float textureIntensity;
                varying float fogIntensity;
        
                const vec4 lightDirection = vec4(-1., -.5, -.5, 1.);
                const highp vec4 defaultPosition = vec4(0., float(${MapViewerConst.globeRenderRadius}), 0., 1.);
                const highp vec4 maxElevation = vec4(0., float(${MapViewerConst.globeRenderRadius})+float(${MapViewerConst.maxElevation}), 0., 1.);
                const vec4 rgba4444ToElevation = vec4(
                    0.93751430533,  // 0xf000/0xffff
                    0.05859464408,  // 0x0f00/0xffff
                    0.00366216525,  // 0x00f0/0xffff
                    0.00022888532); // 0x000f/0xffff
        
                void main()
                {
                    tileUv = uv;
                    vec2 viewportUv = vec3(tileToViewportUv * vec3(uv, 1.)).xy;
        
                    // --------- Calculate globeTexture Coord --------
        
                    vec2 polarCoords = polarOffset + polarDimensions * viewportUv;
                    globeUv = vec2( (polarCoords.x+PI)/PI2, polarCoords.y/PI );
        
                    // -------------- Calculate elevation ------------
        
                    vec3 terrainUv = viewportToTerrainUv * vec3(viewportUv, 1.);
                    float terrainUvFilter = filterUv(terrainUv);
                    vec4 heightmapRgba = texture2D(heightmapTex, terrainUv.xy);
                    float elevation = dot(heightmapRgba, rgba4444ToElevation) * terrainExcentricity * terrainUvFilter;
        
                    // ------------- Calculate Position --------------
                    
                    vec4 viewPosition = vec4(.0, .0, .0, 1.);
                    
                    float avgPolarDimensions = dot(polarDimensions, vec2(.5));
                    if (avgPolarDimensions > 0.1)
                    {
                        vec2 vCos = cos(polarCoords);
                        vec2 vSin = sin(polarCoords);
                        mat4 polarToEuclidian = mat4(
                            vCos.x,           0.,      -vSin.x,        0.,
                            vSin.x * vSin.y,  vCos.y, vCos.x * vSin.y, 0.,
                            vSin.x * vCos.y, -vSin.y, vCos.x * vCos.y, 0.,
                            0.,               0.,     0.,              1.);
                        viewPosition = viewMatrix * polarToEuclidian * defaultPosition;
                        vec4 elevationVector = (viewMatrix * polarToEuclidian * maxElevation - viewPosition) * elevation;
                        viewPosition.xyz += elevationVector.xyz;
                    }
                    else
                    {
                        // At deep zoom levels, a euclidean projection of
                        // of the vertices into the viewport trapezoid is
                        // more precise than trigonometric projection.
                        // 
                        //                    vpTop   ▲ vpHeight * elevation
                        //        vpTopLeft -▶├-------|--------▶
                        //                 vpBottom   ┴
                        //  vpBottomLeft -▶├----------------------▶
                        //
                        
                        vec3 elevationVector = elevation * vpHeight;
                        
                        viewPosition.xyz =
                            mix(
                                vpTopLeft + tileUv.x * vpTop,
                                vpBottomLeft + tileUv.x * vpBottom,
                                tileUv.y
                            ) +
                            elevationVector;
                    }
        
                    gl_Position = projectionMatrix * viewPosition;
        
                    // ---------- Calculate Texture Intensity --------
        
                    float cameraHeight = length(cameraPosition) - float(${MapViewerConst.globeRenderRadius});
                    textureIntensity = smoothstep(50., float(${MapViewerConst.globeRenderRadius})/2., cameraHeight);
        
                    // --------------- Calculate Light ---------------
        
                    mat4 invViewRotationMatrix = mat4(
                        viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0], .0,
                        viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1], .0,
                        viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2], .0,
                        .0, .0, .0, 1.);
        
                    vec4 worldLightDirection = invViewRotationMatrix * lightDirection;
                    vec4 worldCoord = vec4(cameraPosition, 1.) + invViewRotationMatrix * viewPosition;
        
                    float terrainLight = mix(
                        1.,
                        min((texture2D(lightmapTex, terrainUv.xy).a + .15) * .7 + .3, 1.),
                        terrainUvFilter);
                    float globalLight = 1. - textureIntensity * .5 * (
                        dot(worldCoord, worldLightDirection)/
                        (length(worldCoord)*length(worldLightDirection)) + 1.);
        
                    // Apply a soft logistic curve to the light, so that
                    // bright areas appear brighter and a dark areas appear darker.
                    light = max(terrainLight * smoothstep(.47, .52, globalLight), .05);
                    
                    // --------------- Calculate Fog ---------------
                    
                    fogIntensity = smoothstep(cameraViewRadius-.3, cameraViewRadius, distance(viewportUv, cameraPos));
                    // vec2 fogIntensity2d = smoothstep(.85, 1., max(viewportUv, 1.-viewportUv));
                    // fogIntensity = max(fogIntensity2d.x, fogIntensity2d.y);
                    fogIntensity *= (1. - textureIntensity) * float(avgPolarDimensions < ${Math.PI * .5});
                }
            `,

            fragmentShader: `
                #include <common>
                #include <filter_uv_pars>
                #include <tile_pars_fragment>
                
                uniform bool showTexture;
                uniform sampler2D globeTexture;
               
                uniform bool showGrid;
                uniform vec2 gridNumDivs;
                uniform vec2 gridOffset;
                
                uniform vec3 terrainColor;
                uniform bool showShadows;
        
                varying highp vec2 globeUv;
                varying float light;
                varying float textureIntensity;
                varying float fogIntensity;
        
                const vec3 gridLineColor = vec3(.5, .5, .5);
        
                float gridLineFactor()
                {
                    if (!showGrid)
                        return 0.0;
        
                    vec2 cell = gridOffset + tileUv * gridNumDivs;
                    vec2 distToLine = -abs(cell - floor(cell + .5));
                    vec2 lineWidth = fwidth(tileUv) * gridNumDivs;
        
                    distToLine += lineWidth;
                    distToLine /= lineWidth;
                    return clamp(
                        dot(
                            distToLine * vec2(greaterThanEqual(distToLine, vec2(0))),
                            vec2(1)),
                        0., 1.);
                }
        
                void main()
                {
                    float gridLineIntensity = gridLineFactor();
                    
                    // --------- Mix texture and background ---------
                    gl_FragColor = vec4(terrainColor, 1.);
                    if (showTexture) {
                        gl_FragColor.rgb = mix(
                            gl_FragColor.rgb,
                            texture2D(globeTexture, globeUv).rgb,
                            textureIntensity);
                    }
        
                    // ---------------- Apply map tiles --------------
                    #include <tile_sample_and_apply_fragment>
        
                    // ----------------- Apply shadow ----------------
                    if (showShadows) {
                        gl_FragColor.rgb *= light;
                    }
        
                    // ---------------- Apply grid line --------------
                    gl_FragColor.rgb = mix(
                        gl_FragColor.rgb,
                        gridLineColor,
                        gridLineIntensity);
                        
                    // ------------------- Apply fog -----------------
                    gl_FragColor = mix(
                        gl_FragColor,
                        vec4(0.),
                        fogIntensity);
                }
            `
        };

        ShaderLib.globePicking = {
            vertexShader: ShaderLib['globeVisual'].vertexShader,
            fragmentShader: `
            #include <common>
            #include <filter_uv_pars>
            #include <tile_pars_fragment>
            void main() {
                #include <tile_sample_and_apply_fragment>
            }
            `
        };

        ShaderChunk.filter_uv_pars = `
            /// Returns 1. if the given uv is within 0..1 on both axes, 0. otherwise.
            float filterUv(in vec3 uv) {
                return floor(dot(
                    vec2(greaterThanEqual(uv.xy, vec2(0))),
                    vec2(lessThan(uv.xy, vec2(1)))
                ) * .5);
            }
            `;

        ShaderChunk.tile_pars_fragment = `
            varying highp vec2 tileUv;
            uniform vec2 polarOffset;
            uniform vec2 polarDimensions;
            uniform sampler2D tileTexture;
        `;

        ShaderChunk.tile_sample_and_apply_fragment = `
            vec4 tileSample = texture2D(tileTexture, tileUv);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, tileSample.rgb, tileSample.a);
        `;

        ////////////////////////////// Initialization //////////////////////////////

        // -------------------------------------------------------------------------
        // Uniforms for tile 2d map rendering

        function commonUniforms()
        {
            return {
                polarOffset:         { type:"2f",  value: new Vector2() },
                polarDimensions:     { type:"2f",  value: new Vector2() },
                tileTexture:         { type:"t",   value: null },
                heightmapTex:        { type:"t",   value: null },
                terrainExcentricity: { type:"f",   value: 1. },
                viewportToTerrainUv: { type:"3fm", value: new Matrix3() },
                tileToViewportUv:    { type:"3fm", value: new Matrix3() },
                vpTopLeft:           { type:"3f",  value: new Vector3() },
                vpBottomLeft:        { type:"3f",  value: new Vector3() },
                vpTop:               { type:"3f",  value: new Vector3() },
                vpBottom:            { type:"3f",  value: new Vector3() },
                vpHeight:            { type:"3f",  value: new Vector3() },
            }
        }

        // -------------------------------------------------------------------------
        // Create globe materials

        let shaderVisual = ShaderLib["globeVisual"];
        this.materialVisual = new ShaderMaterial(
            {
                uniforms:
                    {
                        // fragment uniforms
                        showGrid:            { type:"i", value: true },
                        showTexture:         { type:"i", value: true },
                        showShadows:         { type:"i", value: true },
                        terrainColor:        { type:"3f", value: new Vector3(.2, .2, .2) },
                        gridNumDivs:         { type:"2f", value: new Vector2() },
                        gridOffset:          { type:"2f", value: new Vector2() },
                        globeTexture:        { type:"t", value: null },
                        lightmapTex:         { type:"t", value: null },
                        cameraViewRadius:    { type:"f", value: .5 },
                        cameraPos:           { type:"2f", value: new Vector2() },

                        ... commonUniforms()
                    },
                vertexShader: shaderVisual.vertexShader,
                fragmentShader: shaderVisual.fragmentShader,
                depthWrite: true
            });

        // Enable derivatives for grid line rendering
        this.materialVisual.extensions.derivatives = true;
        this.materialVisual.transparent = true;

        let shaderPicking = ShaderLib["globePicking"];
        this.materialPicking = new ShaderMaterial(
            {
                uniforms: commonUniforms(),
                vertexShader: shaderPicking.vertexShader,
                fragmentShader: shaderPicking.fragmentShader,
                depthWrite: true
            });

        this.materialsVisual = [...Array(this.vp.renderTileController.numRenderTiles)].map((_, i) => {
            let mat = this.materialVisual.clone();
            mat.uniforms.tileTexture.value = framebuffers.visual[i];
            mat.rendertile = this.vp.renderTileController.tiles[i];
            return mat;
        });

        this.materialsPicking = [...Array(this.vp.renderTileController.numRenderTiles)].map((_, i) => {
            let mat = this.materialPicking.clone();
            mat.uniforms.tileTexture.value = framebuffers.picking[i];
            mat.rendertile = this.vp.renderTileController.tiles[i];
            return mat;
        });

        // -------------------------------------------------------------------------
        // Initialize globe data textures and buffer geometries

        this.bufGeomVertices = null;
        this.bufGeomTexCoord = null;
        this.bufGeomIndices = null;

        this.reallocTerrainTextures();
        this.reallocGlobeGeometry();

        // -------------------------------------------------------------------------
        // Load globe texture

        this.globeTextureLoadPromise = new Promise((resolve, reject) => {
            let loader = new TextureLoader();
            loader.load('/images/naturalearth_albedo_8k.jpg',
                (texture) => {
                    texture.flipY = false;
                    texture.wrapS = RepeatWrapping;
                    this.materialsVisual.forEach(mat => {
                        mat.uniforms.globeTexture.value = texture;
                        mat.uniforms.globeTexture.value.needsUpdate = true;
                    });
                    console.log("Globe texture loaded.");
                    resolve('textureLoaded');
                },
                () => {},
                (_) => {
                    console.log("Error while loading texture.");
                    reject('textureLoaded');
                }
            );
        });

        let geometry = new BufferGeometry();
        geometry.setAttribute("uv", new BufferAttribute(this.bufGeomTexCoord, 2));
        geometry.setAttribute("position", new BufferAttribute(this.bufGeomVertices, 3));
        geometry.setIndex(new BufferAttribute(this.bufGeomIndices, 1));
        geometry.boundingSphere = new Sphere(new Vector3(), MapViewerConst.globeRenderRadius);

        // -------------------------------------------------------------------------
        // Create mesh from material and geometry

        this.meshesVisual = [...Array(this.vp.renderTileController.numRenderTiles)].map((_, i) => {
            let result = new Mesh(geometry, this.materialsVisual[i]);
            result.frustumCulled = false;
            return result;
        });
        this.meshesPicking = [...Array(this.vp.renderTileController.numRenderTiles)].map((_, i) => {
            let result = new Mesh(geometry, this.materialsPicking[i]);
            result.frustumCulled = false;
            return result;
        });
        this.meshes = [...this.meshesVisual, ...this.meshesPicking];
        this.initialised = true;
    }

    reallocTerrainTextures()
    {
        console.assert(this.materialsVisual, this.materialsPicking); // `initialised` is not set yet

        this.heightmapData = new Uint16Array(this.terrain.width*this.terrain.height);
        this.lightmapData = new Uint8Array(this.terrain.width*this.terrain.height);
        this.lightmapData.fill(255);

        let heightmapTex = new DataTexture(
            this.heightmapData,
            this.terrain.width,
            this.terrain.height,
            RGBAFormat,
            UnsignedShort4444Type,
            undefined, undefined, undefined,
            LinearFilter,
            LinearFilter);
        heightmapTex.flipY = true;
        let lightmapTex = new DataTexture(
            this.lightmapData,
            this.terrain.width,
            this.terrain.height,
            AlphaFormat,
            UnsignedByteType,
            undefined, undefined, undefined,
            LinearFilter,
            LinearFilter);
        lightmapTex.flipY = true;

        this.materialsVisual.forEach(mat => {
            mat.uniforms.heightmapTex.value = heightmapTex;
            mat.uniforms.lightmapTex.value = lightmapTex;
        });
        this.materialsPicking.forEach(mat => {
            mat.uniforms.heightmapTex.value = heightmapTex;
        });
    }

    reallocGlobeGeometry()
    {
        // -- Add some vertices to the outermost edges. That's why for this method,
        //  width and height are assumed to be width+2 and height+2:
        //
        //  + ---|--- +   Illustration of extra vertices for a 2*2 heightmap:
        //  | # -|- # |    The original vertices (#) are placed at the center
        //  | |  |  | |    of the pixels. This effectively shrinks the covered
        //  ------------   viewport by half a pixel width on each dimension.
        //  | |  |  | |    With the extra outer vertices (+), This lost coverage is
        //  | # -|- # |    recovered.
        //  + ---|--- +
        

        // -- Allocate sphere patch geometry
        let terrainNumVerticesX = Math.floor(this.terrain.width  / (this.vp.numColumnsPerVpTile * 3));
        let terrainNumVerticesY = Math.floor(this.terrain.height / (this.vp.numRowsPerVpTile * 3));
        let extraOuterVertexCount = terrainNumVerticesX*2 + terrainNumVerticesY*2 + 4;

        this.bufGeomVertices = new Float32Array(
            terrainNumVerticesX *
            terrainNumVerticesY * 3 +
            extraOuterVertexCount * 3);
        this.bufGeomTexCoord = new Float32Array(
            terrainNumVerticesX *
            terrainNumVerticesY * 2 +
            extraOuterVertexCount * 2);
        this.bufGeomIndices = new Uint32Array(
            (terrainNumVerticesX+1) *
            (terrainNumVerticesY+1) * 2 * 3);

        // -- Fill bufGeomTexCoord
        let uvPosition = 0;
        let du = 1./terrainNumVerticesX;
        let dv = 1./terrainNumVerticesY;
        let v = 0;
        for (let vy = 0; vy < terrainNumVerticesY+2; ++vy)
        {
            let u = 0;
            for (let vx = 0; vx < terrainNumVerticesX+2; ++vx)
            {
                this.bufGeomTexCoord[uvPosition++] = u;
                this.bufGeomTexCoord[uvPosition++] = v;

                // For the very first and very last column, only increment u by half the pixel delta
                if ((vx % terrainNumVerticesX) === 0)
                    u += du * .5;
                else
                    u += du;
            }

            if ((vy % terrainNumVerticesY) === 0)
                v += dv * .5;
            else
                v += dv;
        }

        // -- Create required triangle bufGeomIndices
        let indexPosition = 0;
        for (let vy = 0; vy < terrainNumVerticesY+1; ++vy)
        {
            for (let vx = 0; vx < terrainNumVerticesX+1; ++vx)
            {
                let tl = vy * (terrainNumVerticesX+2) + vx;
                let tr = tl + 1;
                let bl = tl + (terrainNumVerticesX+2);
                let br = bl + 1;

                // Create two new triangles for every top-left vertex
                this.bufGeomIndices[indexPosition++] = tl;
                this.bufGeomIndices[indexPosition++] = bl;
                this.bufGeomIndices[indexPosition++] = br;
                this.bufGeomIndices[indexPosition++] = tl;
                this.bufGeomIndices[indexPosition++] = br;
                this.bufGeomIndices[indexPosition++] = tr;
            }
        }

        console.assert(indexPosition === this.bufGeomIndices.length);

        // -- Set on geometry if possible
        if (this.initialised) {
            this.meshes.forEach((mesh) => {
                mesh.geometry.setAttribute("uv", new BufferAttribute(this.bufGeomTexCoord, 2));
                // uvAttr.needsUpdate = true;

                mesh.geometry.setAttribute("position", new BufferAttribute(this.bufGeomVertices, 3));
                // posAttr.needsUpdate = true;

                mesh.geometry.setIndex(new BufferAttribute(this.bufGeomIndices, 1));
                // mesh.geometry.index.needsUpdate = true;
            });
        }
    }

    update()
    {
        let updateMaterialUniforms = (material) =>
        {
            // Ignore the RenderTile if it doesn't have a purpose...
            let subtile = material.rendertile.subtile;
            if (!subtile) {
                material.visible = false;
                return;
            }

            material.visible = true;

            // Grid level
            if (material.uniforms.gridNumDivs) {
                let gridLevel = this.gridLevelValue >= 0 ? this.gridLevelValue : this.vp.gridAutoLevel();
                let gridCellSize = Math.PI / (1 << gridLevel);
                material.uniforms.gridNumDivs.value.set(
                    subtile.angularSize.x / gridCellSize,
                    subtile.angularSize.y / gridCellSize);
                material.uniforms.gridOffset.value.set(
                    ((subtile.angularOffset.x / gridCellSize) % 1) + (subtile.angularOffset.x < 0),
                    ((subtile.angularOffset.y / gridCellSize) % 1) + (subtile.angularOffset.y < 0));
            }

            // Update spherical viewport description
            material.uniforms.polarOffset.value.set(
                this.vp.outer.phiStart, this.vp.outer.thetaStart);
            material.uniforms.polarDimensions.value.set(
                this.vp.outer.phiLength, this.vp.outer.thetaLength);

            // Update viewport camera view radius
            if (material.uniforms.cameraViewRadius)
                material.uniforms.cameraViewRadius.value = this.vp.cameraViewRadius;

            // Update viewport-relative camera pos
            if (material.uniforms.cameraPos)
                material.uniforms.cameraPos.value = this.vp.cameraPos;

            // Update tileToViewportUv
            uvTransform(
                subtile.angularOffset.x, subtile.angularOffset.y, subtile.angularSize.x, subtile.angularSize.y,
                this.vp.outer.phiStart, this.vp.outer.thetaStart, this.vp.outer.phiLength, this.vp.outer.thetaLength,
                material.uniforms.tileToViewportUv.value);

            // Update viewportToTerrainUv
            uvTransform(
                this.vp.outer.phiStart, this.vp.outer.thetaStart, this.vp.outer.phiLength, this.vp.outer.thetaLength,
                this.terrain.phiStart, this.terrain.thetaStart, this.terrain.phiLength, this.terrain.thetaLength,
                material.uniforms.viewportToTerrainUv.value);
        };

        this.materialsVisual.forEach(updateMaterialUniforms);
        this.materialsPicking.forEach(updateMaterialUniforms);
    };

    /**
     * Updates the trapezoid viewport approximation with the current view matrix.
     */
    updateViewTrapezoid(viewMatrix, surfaceRootPosition)
    {
        // -- Euclidean description of viewport result.outer.
        //  These may be used by the vertex shader in place
        //  of per vertex rotations for very deep zoom levels.
        //
        //                    vpTop   ▲ vpHeight * elevation
        //        vpTopLeft -▶├-------|--------▶
        //                 vpBottom   ┴
        //  vpBottomLeft -▶├----------------------▶
        //                
        function sphericalToVec3(p, t) {
            return new Vector3(
                MapViewerConst.globeRenderRadius * Math.sin(t) * Math.sin(p),
                MapViewerConst.globeRenderRadius * Math.cos(t),
                MapViewerConst.globeRenderRadius * Math.sin(t) * Math.cos(p))
        }

        function updateViewTrapezoidForSubtile(mat)
        {
            let subtile = mat.rendertile.subtile;
            if (!subtile)
                return;

            let topLeft = sphericalToVec3(
                subtile.angularOffset.x,
                subtile.angularOffset.y);
            let topRight = sphericalToVec3(
                subtile.angularOffset.x + subtile.angularSize.x,
                subtile.angularOffset.y);
            let bottomLeft = sphericalToVec3(
                subtile.angularOffset.x,
                subtile.angularOffset.y + subtile.angularSize.y);
            let bottomRight = sphericalToVec3(
                subtile.angularOffset.x + subtile.angularSize.x,
                subtile.angularOffset.y + subtile.angularSize.y);

            let vpTopLeft = topLeft.clone().applyMatrix4(viewMatrix);
            let vpBottomLeft = bottomLeft.clone().applyMatrix4(viewMatrix);
            let vpTop = topRight.clone().applyMatrix4(viewMatrix).sub(vpTopLeft);
            let vpBottom = bottomRight.clone().applyMatrix4(viewMatrix).sub(vpBottomLeft);

            let heightDirection = surfaceRootPosition.clone().normalize();
            let vpHeight = heightDirection.clone()
                .multiplyScalar(MapViewerConst.globeRenderRadius + MapViewerConst.maxElevation)
                .applyMatrix4(viewMatrix)
                .sub(heightDirection.clone().multiplyScalar(MapViewerConst.globeRenderRadius).applyMatrix4(viewMatrix));

            mat.uniforms.vpTopLeft.value = vpTopLeft;
            mat.uniforms.vpBottomLeft.value = vpBottomLeft;
            mat.uniforms.vpTop.value = vpTop;
            mat.uniforms.vpBottom.value = vpBottom;
            mat.uniforms.vpHeight.value = vpHeight;
        }

        this.materialsVisual.forEach(updateViewTrapezoidForSubtile);
        this.materialsPicking.forEach(updateViewTrapezoidForSubtile);
    };

    updateTerrain(terrainExtentsAndData)
    {
        let oldTerrainData = this.terrain;
        this.terrain = terrainExtentsAndData;

        if (this.terrain.width !== oldTerrainData.width ||
            this.terrain.height !== oldTerrainData.height)
        {
            this.reallocTerrainTextures();
            this.reallocGlobeGeometry();
        }

        this.update();
        this.heightmapData.set(new Uint16Array(terrainExtentsAndData.data));
        this.lightmapData.set(new Uint8Array(terrainExtentsAndData.light));

        this.materialsVisual.forEach(mat => {
            mat.uniforms.heightmapTex.value.needsUpdate = true;
            mat.uniforms.lightmapTex.value.needsUpdate = true;
        });
        this.materialsPicking.forEach(mat => {
            mat.uniforms.heightmapTex.value.needsUpdate = true;
        });
    };

    showGrid(show) {
        this.materialsVisual.forEach(mat => mat.uniforms.showGrid.value = show);
    };

    gridLevel(level) {
        this.gridLevelValue = level;
        this.update();
    };

    showTexture(show) {
        this.materialsVisual.forEach(mat => mat.uniforms.showTexture.value = show);
    };

    showShadow(value) {
        this.materialsVisual.forEach(mat => mat.uniforms.showShadows.value = value);
    };

    terrainExcentricity(value) {
        this.terrainExcentricityValue = value;
        this.materialsVisual.forEach(mat => mat.uniforms.terrainExcentricity.value = value);
        this.materialsPicking.forEach(mat => mat.uniforms.terrainExcentricity.value = value);
    };

    terrainColor(colorStr) {
        let rgb = parseInt(colorStr.slice(1), 16);
        let value = new Vector3(
            ((rgb >> 16) & 255)/255.,
            ((rgb >> 8) & 255)/255.,
            (rgb & 255)/255.);
        this.materialsVisual.forEach(mat => mat.uniforms.terrainColor.value = value);
    };

    scaleSceneVecToTerrainHeight(pos, u, v)
    {
        // Calculate texture coordinates to make a heightmapTex lookup
        if (u === undefined)
            u = Math.atan2(pos.x, pos.z);
        if (v === undefined)
            v = Math.acos(pos.y/pos.length());

        u -= this.terrain.phiStart;
        v -= this.terrain.thetaStart;
        u /= this.terrain.phiLength;
        v /= this.terrain.thetaLength;
        u = Math.max(.0, Math.min(1., u));
        v = Math.max(.0, Math.min(1., v));
        v = 1. - v;

        let height = (() => {
            let heightmapLookupIdx =
                Math.floor(v*(this.terrain.height-1)) * this.terrain.width +
                Math.floor(u*(this.terrain.width-1));

            if (isNaN(heightmapLookupIdx) || heightmapLookupIdx < 0 || heightmapLookupIdx >= this.heightmapData.length)
                return .0;

            // max height over 9 pixels
            // TODO: Change to bilinear interpolation
            let result = 0;
            for (let iv = -1; iv <= 1; ++iv) {
                for (let iu = -1; iu <= 1; ++iu) {
                    let actualIdx = heightmapLookupIdx + iv * this.terrain.width + iu;
                    if (actualIdx >= 0 && actualIdx < this.heightmapData.length)
                        result = Math.max(result, this.heightmapData[actualIdx]);
                }
            }

            return result
        })();

        pos.normalize().multiplyScalar(
            MapViewerConst.globeRenderRadius+
            height/65535. * MapViewerConst.maxElevation * this.terrainExcentricityValue)
    };
}
