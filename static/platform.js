import {SingleShotTimer} from "/mapcomponent/timer.js";

export var platform = function()
{
    let currentState = new URL(window.location.toString());

    let stateChangeDebounceTimer = new SingleShotTimer(500, () => {
        history.replaceState(null, "NDS Mapviewer", currentState.toString());
    }, true);

    return {
        name: "web",
        getState: function(paramName, defaultValue="", setIfMissing=true) {
            const urlParams = new URLSearchParams(window.location.search);
            let param = urlParams.get(paramName);
            switch (param) {
                case null:
                    if (setIfMissing) {
                        platform.setState(paramName, defaultValue);
                    }
                    return defaultValue;
                case "true":
                    param = true;
                    break;
                case "false":
                    param = false;
                    break;
                default:
                    if (defaultValue !== undefined && defaultValue.constructor) {
                        param = defaultValue.constructor(param);
                    }
            }
            return param;
        },
        getStateNumeric: function(paramName, defaultValue=0) {
            return Number(platform.getState(paramName, defaultValue));
        },
        setState: function(key, value) {
            currentState.searchParams.set(key, value);
            stateChangeDebounceTimer.restart();
        },
        deleteState: function(key) {
            currentState.searchParams.delete(key);
            stateChangeDebounceTimer.restart();
        },
        clearState: function(exceptions) {
            Array.from(currentState.searchParams.keys()).forEach((x) => {
                if (!exceptions || exceptions.indexOf(x) < 0)
                    currentState.searchParams.delete(x);
            })
            stateChangeDebounceTimer.restart();
        },
        mouse: {Left: 0, Right: 2, Middle: 1},
        key: {
            Shift: "Shift", Plus: "+", Minus: "-", D: "D",
            Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown",
            Esc: "Escape"
        },
    };
} ();
