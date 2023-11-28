import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
import { AppModule } from './app/app.module';
import { SingleShotTimer } from "./app/timer.service";

export var platform = function() {
    let currentState = new URL(window.location.toString());

    let stateChangeDebounceTimer = new SingleShotTimer(500, () => {
        history.replaceState(null, "NDS Mapviewer", currentState.toString());
    }, true);

    return {
        name: "web",
        getState: function(paramName: string, defaultValue: string | number = "", setIfMissing: boolean = true) {
            const urlParams = new URLSearchParams(window.location.search);
            let param = urlParams.get(paramName);
            switch (param) {
                case null:
                    if (setIfMissing) {
                        platform.setState(paramName, defaultValue.toString());
                    }
                    return defaultValue;
                case "true":
                    return true;
                case "false":
                    return false;
                default:
                    if (defaultValue !== undefined && defaultValue.constructor) {
                        param = defaultValue.constructor(param);
                    }
            }
            return param;
        },
        getStateNumeric: function(paramName: string, defaultValue: string | number = 0) {
            return Number(platform.getState(paramName, defaultValue));
        },
        setState: function(key: string, value: string) {
            currentState.searchParams.set(key, value);
            stateChangeDebounceTimer.restart();
        },
        deleteState: function(key: string) {
            currentState.searchParams.delete(key);
            stateChangeDebounceTimer.restart();
        },
        clearState: function(exceptions: string | string[]) {
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

platformBrowserDynamic().bootstrapModule(AppModule)
  .catch(err => console.error(err));
