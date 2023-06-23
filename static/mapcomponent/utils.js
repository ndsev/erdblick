"use strict";

import {
    Vector3,
    Matrix3
} from "../deps/three.js";
import {SingleShotTimer} from "./timer.js";

/**
 * Convert degree to rad.
 */
export function degreeToRad(degrees) {
    return (degrees%180.0) * Math.PI / 180.0;
}

/**
 * Convert rad to degrees.
 */
export function radToDegree(rad) {
    return (rad%Math.PI) * 180.0 / Math.PI;
}

/**
 * Snaps a value to a certain modular alignment. Value will be increased if up, decreased otherwise.
 * If the value is already in alignment, nothing will be done.
 */
export function align(x, alignment, up) {
    let modulus = x % alignment;
    if (modulus === 0)
        return x;
    return x - modulus + Math.sign(x)*alignment*( (!up && (x < 0)) || (up && (x > 0)) )
}

/**
 * Calculate Wgs84 coordinates from absolute cartesian world space.
 */
export function wgs84FromScenePos(pos, globeRadius) {
    let longitude = radToDegree(Math.atan2(pos.x, pos.z));
    let latitude = radToDegree(Math.asin(pos.y/pos.length()));
    return new Vector3(longitude, latitude, globeRadius);
}

/**
 * Convert longitude-latitude to 3D cartesian sphere.
 *
 * @param {number} lon
 * @param {number} lat
 * @param {number} radius
 * @param {number} [height=0]
 * @param {number} [offset=0]
 * @return {Vector3}
 */
export function scenePosFromWgs84(lon, lat, radius, height, offset) {
    height = height || 0;

    let phi = degreeToRad(lon);
    let theta = degreeToRad(lat);

    let result = new Vector3(
        (radius+height) * Math.cos(theta) * Math.sin(phi),
        (radius+height) * Math.sin(theta),
        (radius+height) * Math.cos(theta) * Math.cos(phi));

    if (offset)
        result.sub(offset)

    return result
}

/**
 * Cubic Hermite interpolation, returning a value in the range 0.0 to 1.0.
 */
export function smoothstep(min, max, value) {
    let x = Math.max(0, Math.min(1, (value-min)/(max-min)));
    return x*x*(3 - 2*x);
}

/**
 * Throttle calls to a function to always have at least a specific interval inbetween.
 */
export function throttle(minIv, fn)
{
    let lastExecTimestamp = new Date(0);
    let lastArgs = [];
    let finalCallTimer = new SingleShotTimer(minIv, ()=>fn(...lastArgs), true);

    return (...args) =>
    {
        lastArgs = args;
        let currentTime = new Date();
        if (currentTime - lastExecTimestamp < minIv) {
            finalCallTimer.restart();
            return;
        }
        finalCallTimer.stop();
        lastExecTimestamp = currentTime;
        fn(...args);
    };
}

/**
 * Create a UV transform matrix between two rectangles in a common coordinate system.
 * @return {Matrix3}
 */
export function uvTransform(srcOffX, srcOffY, srcSizeX, srcSizeY, destOffX, destOffY, destSizeX, destSizeY, result) {
    result = result || new Matrix3();
    result.set(
        srcSizeX/destSizeX, 0, (srcOffX - destOffX)/destSizeX,
        0, srcSizeY/destSizeY, (srcOffY - destOffY)/destSizeY,
        0, 0, 1);
    return result;
}

/**
 * Option the first value of a cookie with a specific name.
 */
export function cookieValue(cookieName) {
    for (let cookie of document.cookie.split(';')) {
        let keyValuePair = cookie.trim().split("=");
        if (keyValuePair.length < 2)
            continue;
        if (keyValuePair[0].trim() === cookieName)
            return keyValuePair[1].trim();
    }
    return null;
}

/**
 * Generate a unique id for this browser.
 */
export function generateUUID() {
    var d = new Date().getTime();
    var d2 = ((typeof performance !== 'undefined') && performance.now && (performance.now()*1000)) || 0;
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16;
        if (d > 0) {
            r = (d + r)%16 | 0;
            d = Math.floor(d / 16);
        } else {
            // Use microseconds since page-load if supported.
            r = (d2 + r)%16 | 0;
            d2 = Math.floor(d2/16);
        }
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

/**
 * Get the browser id from the cookie. Generates a new cookie if none is present.
 */
export function browserCookieValue() {
    let browserCookie = cookieValue("mapviewer-browser-id");
    if (browserCookie === null) {
        const date = new Date();
        date.setTime(date.getTime() + 10 * 365 * 24 * 60 * 60);
        let expires = "expires=" + date.toUTCString();
        let uuid = generateUUID();
        document.cookie = "mapviewer-browser-id=" + uuid + ";" + expires + ";path=/";
        return uuid;
    } else {
        return browserCookie;
    }
}

/**
 * Create an HTML DOM node from an HTML string.
 * @param htmlString HTML to parse into DOM.
 */
export function makeDomNode(htmlString) {
    let result = $.parseHTML($.trim(htmlString));
    if (result.length !== 1)
        throw RangeError(`Expected to parse 1 DOM node, got ${result.length}.`)
    return result[0];
}

/**
 * Filter mesh object based on their name
 */
export function filterMeshObjectsByName(mesh) {
    const allowedSubstrings = ["surface", "landmark"]
    if (mesh.name) {
        for (let substring of allowedSubstrings) {
            if (mesh.name.toLowerCase().includes(substring)) {
                return true;
            }
        }
    }
    return false;
}
