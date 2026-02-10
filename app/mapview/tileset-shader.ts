import {
    CustomShader,
    CustomShaderTranslucencyMode,
    LightingModel,
    UniformType,
    VaryingType
} from "../integrations/cesium";

let cachedShader: CustomShader | undefined;

export function getTilesetMeshlineShader(): CustomShader {
    if (cachedShader && !cachedShader.isDestroyed()) {
        return cachedShader;
    }

    cachedShader = new CustomShader({
        lightingModel: LightingModel.UNLIT,
        translucencyMode: CustomShaderTranslucencyMode.TRANSLUCENT,
        uniforms: {
            u_widthMode: {
                type: UniformType.FLOAT,
                value: 0.0,
            },
            u_widthScale: {
                type: UniformType.FLOAT,
                value: 1.0,
            },
            u_debugShowCenterline: {
                type: UniformType.FLOAT,
                value: 0.0,
            },
        },
        varyings: {
            v_color: VaryingType.VEC4,
            v_gapColor: VaryingType.VEC4,
            v_lineU: VaryingType.FLOAT,
            v_lineSide: VaryingType.FLOAT,
            v_widthPx: VaryingType.FLOAT,
            v_dashLength: VaryingType.FLOAT,
            v_dashPattern: VaryingType.FLOAT,
            v_arrowMode: VaryingType.FLOAT,
            v_mpp: VaryingType.FLOAT,
            v_isLine: VaryingType.FLOAT,
        },
        vertexShaderText: `
void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
    vec3 positionMC = vsInput.attributes.positionMC;
    vsOutput.positionMC = positionMC;

    vec2 tc0 = vsInput.attributes.texCoord_0;
    vec2 tc1 = vsInput.attributes.texCoord_1;
    vec2 tc2 = vsInput.attributes.texCoord_2;

    float lineSide = tc0.y;
    float widthPx = tc1.x;
    vec3 right = vsInput.attributes.normalMC;
    float rightLen = length(right);
    if (widthPx <= 0.0 && rightLen > 0.0) {
        // Fallback when TEXCOORD_1 isn't available: encode width in normal length.
        widthPx = rightLen;
    }
    if (rightLen > 0.0) {
        right /= rightLen;
    }

    v_color = vsInput.attributes.color_0;
    v_gapColor = vsInput.attributes.color_1;
    v_lineU = tc0.x;
    v_lineSide = lineSide;
    v_widthPx = widthPx;
    v_dashLength = tc1.y;
    v_dashPattern = tc2.x;
    v_arrowMode = tc2.y;

    float isLine = step(0.5, abs(lineSide));
    v_isLine = isLine;

    vec4 positionEC = czm_modelViewRelativeToEye * vec4(positionMC, 1.0);
    float mpp = max(0.0, czm_metersPerPixel(positionEC));
    v_mpp = mpp;

    if (isLine > 0.5) {
        float widthMeters = widthPx * mpp;
        if (u_widthMode > 0.5) {
            widthMeters = widthPx;
        }
        widthMeters *= u_widthScale;
        float halfWidth = 0.5 * widthMeters;
        vsOutput.positionMC += right * (lineSide * halfWidth);
    } else if (widthPx > 0.0) {
        vsOutput.pointSize = widthPx;
    }
}
        `,
        fragmentShaderText: `
float dashMask(float lineU_px, float dashLengthPx, float dashPattern) {
    float maskLength = 16.0;
    float dashPosition = fract(lineU_px / max(dashLengthPx, 1.0));
    float maskIndex = floor(dashPosition * maskLength);
    float maskTest = floor(dashPattern / pow(2.0, maskIndex));
    return step(0.5, mod(maskTest, 2.0));
}

float arrowMaskFor(float arrowPos, float lineSideAbs, float arrowHeadStart) {
    if (arrowPos <= arrowHeadStart) {
        return 1.0;
    }
    float t = (arrowPos - arrowHeadStart) / max(1.0 - arrowHeadStart, 1e-4);
    float halfWidth = 1.0 - t;
    return step(lineSideAbs, halfWidth);
}

void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
    vec4 baseColor = v_color;
    float alpha = baseColor.a;
    bool isCenterline = v_arrowMode < -0.5;

    if (isCenterline) {
        if (u_debugShowCenterline < 0.5) {
            material.diffuse = vec3(0.0);
            material.alpha = 0.0;
            return;
        }
        material.diffuse = baseColor.rgb;
        material.alpha = alpha;
        return;
    }

    if (v_isLine > 0.5) {
        float lineU_px = v_lineU / max(v_mpp, 1e-6);
        float arrowMode = v_arrowMode;

        if (arrowMode > 0.5) {
            // TODO: Re-enable arrowhead masking once the base line rendering is solid.
            // For now, keep the full line visible so we can validate mesh-line geometry.
        } else if (v_dashPattern > 0.5 && v_dashLength > 0.5) {
            float dashOn = dashMask(lineU_px, v_dashLength, v_dashPattern);
            baseColor = mix(v_gapColor, v_color, dashOn);
            alpha = baseColor.a;
        }
    }

    material.diffuse = baseColor.rgb;
    material.alpha = alpha;
}
        `,
    });

    return cachedShader;
}
