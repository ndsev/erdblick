"use strict";

export class SingleShotTimer
{
    private interval: number;
    private timer: number | null;
    private callback: any;

    constructor(interval: number, callback: any, waitForRestart: boolean) {
        this.interval = interval;
        this.callback = callback;
        this.timer = null;
        if (!waitForRestart) this.restart(interval);
    }

    restart(interval: number | undefined = undefined) {
        if (interval === undefined)
            interval = this.interval;
        this.stop();
        this.timer = window.setTimeout(this.callback, interval);
    }

    stop() {
        if (this.timer)
            window.clearTimeout(this.timer);
        this.timer = null;
    }
}
