export class SingleShotTimer
{
    constructor(interval, callback, waitForRestart) {
        this.interval = interval;
        this.callback = callback;
        this.timer = null;
        if (!waitForRestart)
            this.restart();
    }

    restart(interval) {
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
