import { BehaviorSubject } from "rxjs";

/**
 * Atomized state unit that extends BehaviorSubject with URL serialization
 * and validation capabilities.
 */
export class AppState<T> extends BehaviorSubject<T> {
    private _isDirty: boolean = false;

    constructor(
        private pool: Map<string, AppState<any>>,
        private converter: (val: string) => T,
        private validator: (val: T) => boolean,
        public readonly defaultValue: T,
        public readonly name: string = "",
        public readonly urlParamName: string = "",
        public readonly urlFormEncoded: boolean = false
    ) {
        super(defaultValue);
        
        // Register this state in the pool
        if (name) {
            pool.set(name, this);
        }
    }

    /**
     * Parse value from URL parameter string
     */
    parseFromUrl(value: string): boolean {
        try {
            const converted = this.converter(value);
            if (this.validator(converted)) {
                this._isDirty = false;
                this.next(converted);
                return true;
            }
        } catch (e) {
            console.warn(`Failed to parse ${this.name} from URL: ${value}`, e);
        }
        return false;
    }

    /**
     * Override next to track dirty state
     */
    override next(value: T): void {
        if (JSON.stringify(value) !== JSON.stringify(this.getValue())) {
            this._isDirty = true;
            super.next(value);
        }
    }

    /**
     * Serialize value for URL parameter
     */
    toUrlValue(): string | null {
        if (!this.urlParamName) return null;
        
        const value = this.getValue();
        
        // Don't serialize default values unless they've been explicitly set
        if (!this._isDirty && JSON.stringify(value) === JSON.stringify(this.defaultValue)) {
            return null;
        }
        
        if (this.urlFormEncoded && typeof value === 'object') {
            return this.formEncode(value);
        }
        
        return this.stringifyForUrl(value);
    }

    /**
     * Convert value to URL-friendly string
     */
    private stringifyForUrl(value: any): string {
        return JSON.stringify(value, (_: string, v: any) => 
            typeof v === 'boolean' ? (v ? 1 : 0) : v
        );
    }

    /**
     * Form-encode object for URL parameters
     */
    private formEncode(obj: any): string {
        const params = new URLSearchParams();
        Object.entries(obj).forEach(([key, val]) => {
            if (val !== null && val !== undefined) {
                params.append(key, String(val));
            }
        });
        return params.toString();
    }

    /**
     * Reset to default value
     */
    reset(): void {
        this._isDirty = false;
        this.next(this.defaultValue);
    }

    /**
     * Check if value has been modified from default
     */
    get isDirty(): boolean {
        return this._isDirty;
    }
}

/**
 * Interface for camera view data
 */
export interface CameraViewData {
    lon: number;
    lat: number;
    alt: number;
    heading: number;
    pitch: number;
    roll: number;
}

/**
 * Interface for 2D view rectangle data
 */
export interface ViewRectangleData {
    west: number;
    south: number;
    east: number;
    north: number;
}
