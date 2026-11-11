/**
 * Specialized ground-path shaders for the transient 3px aqua location boundary.
 * Miter construction and clipping follow deck.gl PathLayer (MIT, vis.gl contributors).
 * Projection and join directions are prepared once, keeping all original vertices.
 */
export const LOCATION_OUTLINE_VERTEX_SHADER = `#version 300 es
#define SHADER_NAME location-outline-vertex-shader
in vec2 positions;
in vec4 startPosition;
in vec4 endPosition;
in vec4 startJoin;
in vec4 endJoin;
in vec2 startInfo;
in vec2 endInfo;
out float vMiterLength;
out float vPathPosition;
out float vPathLength;

void main() {
    vMiterLength = 0.0;
    vPathPosition = 0.0;
    vPathLength = 0.0;
    // Separators and zero-length edges have no visible area; do not connect distinct rings.
    if (startInfo.y <= 0.0) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
    }
    float isEnd = positions.x;
    float side = positions.y;
    float isJoint = float(side == 0.0);
    vec4 position = mix(startPosition, endPosition, isEnd);
    vec4 join = mix(startJoin, endJoin, isEnd);
    float turn = mix(startInfo.x, endInfo.x, isEnd);
    float width = project_pixel_size(1.5);
    // Subtract high parts before adding low parts, preserving short segments at high zoom.
    vec2 direction = ((endPosition.xy - startPosition.xy) + (endPosition.zw - startPosition.zw)) / startInfo.y;
    vec2 perpendicular = vec2(-direction.y, direction.x);
    float corner = side * turn;
    float miterSize = corner < 0.0 ? min(join.z, join.w / width) : join.z;
    vec2 offset = mix(join.xy * miterSize, perpendicular, step(0.5, corner)) * (side + isJoint * turn);
    bool isCap = turn == 0.0;
    if (isCap) offset = perpendicular * side;
    vMiterLength = isCap ? isJoint : dot(offset, join.xy * turn);
    vPathLength = startInfo.y / width;
    vPathPosition = dot(offset, direction) + isEnd * vPathLength;
    geometry.position = vec4(project_position(vec3(position.xy, 0.0), vec3(position.zw, 0.0)) + vec3(offset * width, 0.0), 1.0);
    gl_Position = project_common_position_to_clipspace(geometry.position);
    DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
}`;

/** Retains PathLayer's miter-limit clipping and Deck's opacity without per-fragment reprojection. */
export const LOCATION_OUTLINE_FRAGMENT_SHADER = `#version 300 es
#define SHADER_NAME location-outline-fragment-shader
precision highp float;
in float vMiterLength;
in float vPathPosition;
in float vPathLength;
out vec4 fragColor;
void main() {
    if ((vPathPosition < 0.0 || vPathPosition > vPathLength) && vMiterLength > 5.0) discard;
    fragColor = vec4(0.0, 1.0, 1.0, layer.opacity);
    DECKGL_FILTER_COLOR(fragColor, geometry);
}`;
