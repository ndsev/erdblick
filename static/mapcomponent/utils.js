"use strict";

import {SingleShotTimer} from "./timer.js";

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
