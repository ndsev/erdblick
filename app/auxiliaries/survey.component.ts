import {Component, OnDestroy, OnInit} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {Subscription} from "rxjs";

interface SurveyConfig {
    id: string;
    link: string;
    linkHtml: string;
    start?: string;
    end?: string;
    emoji?: string;
    background?: string;
}

@Component({
    selector: 'survey',
    template: `
        @if (surveyEnabled) {
            <div id="survey" [style]="{'backgroundColor': backgroundColor}" [class]="{'hidden': isSurveyHidden}">
            <span class="survey-icon" style="font-size: 1.75em" (click)="triggerFireworks()">
                {{ surveyEmoji }}
            </span>
                <a [href]="surveyHref" [innerHTML]="surveyLinkHtml"></a>
                <span class="material-symbols-outlined" (click)="dismissSurvey($event)">
                close
            </span>
                @if (showFireworks) {
                    <div class="survey-fireworks">
                        <span class="firework f1"></span>
                        <span class="firework f2"></span>
                        <span class="firework f3"></span>
                        <span class="firework f4"></span>
                        <span class="firework f5"></span>
                        <span class="firework f6"></span>
                        <span class="firework f7"></span>
                        <span class="firework f8"></span>
                        <span class="firework f9"></span>
                        <span class="firework f10"></span>
                        <span class="firework f11"></span>
                        <span class="firework f12"></span>
                        <span class="firework f13"></span>
                        <span class="firework f14"></span>
                        <span class="firework f15"></span>
                        <span class="firework f16"></span>
                    </div>
                }
            </div>
        }
    `,
    styles: [``],
    standalone: false
})
/**
 * Config-driven announcement banner shown at the top of the application.
 *
 * The active survey is chosen by date range from `config.json`; state updates
 * are deferred one macrotask to avoid Angular startup expression-change errors.
 */
export class SurveyComponent implements OnInit, OnDestroy {
    surveyEnabled: boolean = false;
    isSurveyHidden: boolean = false;
    showFireworks: boolean = false;
    surveyEmoji: string = "";
    surveyHref: string = "";
    surveyLinkHtml: string = "";
    backgroundColor: string = "blueviolet";
    private fireworksAnimating: boolean = false;
    private fireworksQueue: number = 0;
    private configSubscription?: Subscription;
    private configApplyTimeout?: number;

    constructor(private httpClient: HttpClient) {
    }

    /** Loads the survey configuration from `config.json` once the component mounts. */
    ngOnInit() {
        this.configSubscription = this.httpClient.get("config.json", {responseType: 'json'}).subscribe({
            next: (data: any) => {
                this.scheduleApplySurveyConfig(data);
            },
            error: error => {
                console.error(error);
            }
        });
    }

    /** Cancels the config subscription and any deferred config-apply callback. */
    ngOnDestroy() {
        this.configSubscription?.unsubscribe();
        if (this.configApplyTimeout !== undefined) {
            window.clearTimeout(this.configApplyTimeout);
            this.configApplyTimeout = undefined;
        }
    }

    /** Hides the active survey banner for the current page session. */
    dismissSurvey(event: any) {
        event.stopPropagation();
        this.isSurveyHidden = true;
    }

    /** Starts the fireworks animation, queueing a few extra clicks if needed. */
    triggerFireworks() {
        if (this.isSurveyHidden || !this.surveyEnabled) {
            return;
        }

        if (this.fireworksAnimating) {
            if (this.fireworksQueue < 5) {
                this.fireworksQueue++;
            }
            return;
        }

        this.startFireworksAnimation();
    }

    /** Runs one fireworks cycle and chains queued cycles after the current one completes. */
    private startFireworksAnimation() {
        this.fireworksAnimating = true;
        this.showFireworks = true;
        window.setTimeout(() => {
            this.showFireworks = false;
            this.fireworksAnimating = false;

            if (this.fireworksQueue > 0) {
                this.fireworksQueue--;
                window.setTimeout(() => {
                    this.startFireworksAnimation();
                }, 0);
            }
        }, 800);
    }

    /** Defers survey-config application so startup change detection stays stable in dev mode. */
    private scheduleApplySurveyConfig(config: any) {
        if (this.configApplyTimeout !== undefined) {
            window.clearTimeout(this.configApplyTimeout);
        }
        // `config.json` can be served from caches fast enough to arrive during initial startup CD.
        // Apply in the next macrotask to avoid dev-mode ExpressionChanged errors.
        this.configApplyTimeout = window.setTimeout(() => {
            this.configApplyTimeout = undefined;
            try {
                this.applySurveyConfig(config);
            } catch (error) {
                console.error(error);
            }
        }, 0);
    }

    /** Picks the first currently active survey entry and copies its presentation fields into state. */
    private applySurveyConfig(config: any) {
        this.surveyEnabled = false;
        this.surveyHref = "";
        this.surveyLinkHtml = "";
        this.surveyEmoji = "";
        this.backgroundColor = "blueviolet";

        if (!config || !Array.isArray(config["surveys"])) {
            return;
        }

        const surveys: SurveyConfig[] = config["surveys"] as SurveyConfig[];
        const now = new Date();
        const nowTime = now.getTime();

        let activeSurvey: SurveyConfig | null = null;

        for (const entry of surveys) {
            const start = entry.start ? this.parseSurveyDate(entry.start, false) : null;
            const end = entry.end ? this.parseSurveyDate(entry.end, true) : null;

            if (start && nowTime < start.getTime()) {
                continue;
            }
            if (end && nowTime > end.getTime()) {
                continue;
            }

            activeSurvey = entry;
            break;
        }

        if (!activeSurvey) {
            return;
        }

        this.surveyHref = activeSurvey.link;
        this.surveyLinkHtml = activeSurvey.linkHtml;

        if (typeof activeSurvey.emoji === 'string' && activeSurvey.emoji.length) {
            this.surveyEmoji = activeSurvey.emoji;
        }
        if (typeof activeSurvey.background === 'string' && activeSurvey.background.length) {
            this.backgroundColor = activeSurvey.background;
        }
        this.surveyEnabled = true;
    }

    /** Parses a survey date in local time, optionally expanding it to the end of that day. */
    private parseSurveyDate(dateString: string, endOfDay: boolean): Date | null {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
        if (!match) {
            return null;
        }

        const year = Number(match[1]);
        const month = Number(match[2]) - 1;
        const day = Number(match[3]);

        if (!year || month < 0 || month > 11 || !day) {
            return null;
        }
        if (endOfDay) {
            return new Date(year, month, day, 23, 59, 59, 999);
        }
        return new Date(year, month, day, 0, 0, 0, 0);
    }
}
