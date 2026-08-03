/** Physical WGS84 coordinate retained by three-dimensional map navigation. */
export type NavigationAnchor = [
    longitude: number,
    latitude: number,
    altitude: number
];

/** View-local CSS pixel used to acquire or retain a navigation anchor. */
export type NavigationScreenPosition = [x: number, y: number];

/** Resolves a view-local screen position to an eligible physical coordinate. */
export type NavigationAnchorProvider = (
    screenPosition: NavigationScreenPosition
) => NavigationAnchor | null;

/** Supplies the last application-retained coordinate for pointerless commands. */
export type RetainedNavigationAnchorProvider = () => NavigationAnchor | null;

/** Reports when a controller acquires, retains, or releases a physical coordinate. */
export type NavigationAnchorChangeHandler = (
    anchor: NavigationAnchor | null,
    active: boolean
) => void;
