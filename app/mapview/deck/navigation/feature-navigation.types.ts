/** Physical WGS84 coordinate retained by three-dimensional map navigation. */
export type NavigationAnchor = [
    longitude: number,
    latitude: number,
    altitude: number
];

/** Local east/north/up direction used only to orient an Erdblick navigation visual. */
export type NavigationSurfaceNormal = [east: number, north: number, up: number];

/** Physical target plus optional renderer-owned orientation metadata. */
export interface NavigationVisualTarget {
    position: NavigationAnchor;
    surfaceNormal?: NavigationSurfaceNormal;
}

/** View-local CSS pixel used to acquire or retain a navigation anchor. */
export type NavigationScreenPosition = [x: number, y: number];
