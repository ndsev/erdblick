import {HttpClient} from "@angular/common/http";
import {Injectable} from "@angular/core";
import {firstValueFrom, Subject} from "rxjs";

/** Calls the guarded mapget cache-reset endpoint and announces completed resets to active views. */
@Injectable({providedIn: "root"})
export class CacheResetService {
    private readonly completed = new Subject<string>();
    readonly completed$ = this.completed.asObservable();

    constructor(private readonly httpClient: HttpClient) {}

    /** Clears one map's server tile cache and emits only after the server confirms success. */
    async reset(mapId: string): Promise<void> {
        if (!mapId) {
            throw new Error("A map ID is required.");
        }
        await firstValueFrom(
            this.httpClient.post<void>(
                "/cache/reset",
                {mapId}
            )
        );
        this.completed.next(mapId);
    }
}
