/**
 * Version labels supplied by the running distribution, never user preferences.
 * These describe the loaded deployment, so a previous browser session must not
 * override them through local storage, a config-state default or a shared link.
 */

/** One package advertised by the distribution versions module. */
export interface DistributionVersion {
    readonly name: string;
    readonly tag: string;
    readonly whatsnew?: string;
}

/** Read-only version snapshot shared by About and diagnostic exports. */
export interface RuntimeVersions {
    readonly distributionVersions: readonly DistributionVersion[];
    readonly erdblickVersion: string;
}
