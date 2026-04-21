const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const EARTH_RADIUS_METERS = 6378137;

/** Minimal `Cartesian2` replacement used by the lightweight geo integration shim. */
class Cartesian2Impl {
    constructor(public x: number = 0, public y: number = 0) {}
}

/** Minimal `Cartesian3` replacement that implements only the vector ops erdblick needs. */
class Cartesian3Impl {
    constructor(public x: number = 0, public y: number = 0, public z: number = 0) {}

    /** Converts degrees plus height into an ECEF-like Cartesian approximation. */
    static fromDegrees(longitudeDegrees: number, latitudeDegrees: number, heightMeters: number = 0): Cartesian3Impl {
        const lon = longitudeDegrees * DEG_TO_RAD;
        const lat = latitudeDegrees * DEG_TO_RAD;
        const cosLat = Math.cos(lat);
        const radius = EARTH_RADIUS_METERS + heightMeters;
        return new Cartesian3Impl(
            radius * cosLat * Math.cos(lon),
            radius * cosLat * Math.sin(lon),
            radius * Math.sin(lat)
        );
    }

    /** Returns Euclidean distance between two cartesian points. */
    static distance(lhs: Cartesian3Impl, rhs: Cartesian3Impl): number {
        const dx = lhs.x - rhs.x;
        const dy = lhs.y - rhs.y;
        const dz = lhs.z - rhs.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    /** Subtracts two vectors into the provided result object. */
    static subtract(lhs: Cartesian3Impl, rhs: Cartesian3Impl, result: Cartesian3Impl = new Cartesian3Impl()): Cartesian3Impl {
        result.x = lhs.x - rhs.x;
        result.y = lhs.y - rhs.y;
        result.z = lhs.z - rhs.z;
        return result;
    }

    /** Adds two vectors into the provided result object. */
    static add(lhs: Cartesian3Impl, rhs: Cartesian3Impl, result: Cartesian3Impl = new Cartesian3Impl()): Cartesian3Impl {
        result.x = lhs.x + rhs.x;
        result.y = lhs.y + rhs.y;
        result.z = lhs.z + rhs.z;
        return result;
    }

    /** Computes the vector cross product into the provided result object. */
    static cross(lhs: Cartesian3Impl, rhs: Cartesian3Impl, result: Cartesian3Impl = new Cartesian3Impl()): Cartesian3Impl {
        result.x = lhs.y * rhs.z - lhs.z * rhs.y;
        result.y = lhs.z * rhs.x - lhs.x * rhs.z;
        result.z = lhs.x * rhs.y - lhs.y * rhs.x;
        return result;
    }

    /** Normalizes a vector, returning zero when the input is effectively degenerate. */
    static normalize(vector: Cartesian3Impl, result: Cartesian3Impl = new Cartesian3Impl()): Cartesian3Impl {
        const length = Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
        if (length <= 1e-12) {
            result.x = 0;
            result.y = 0;
            result.z = 0;
            return result;
        }
        result.x = vector.x / length;
        result.y = vector.y / length;
        result.z = vector.z / length;
        return result;
    }

    /** Negates a vector into the provided result object. */
    static negate(vector: Cartesian3Impl, result: Cartesian3Impl = new Cartesian3Impl()): Cartesian3Impl {
        result.x = -vector.x;
        result.y = -vector.y;
        result.z = -vector.z;
        return result;
    }

    /** Multiplies a vector by a scalar into the provided result object. */
    static multiplyByScalar(vector: Cartesian3Impl, scalar: number, result: Cartesian3Impl = new Cartesian3Impl()): Cartesian3Impl {
        result.x = vector.x * scalar;
        result.y = vector.y * scalar;
        result.z = vector.z * scalar;
        return result;
    }
}

/** Minimal `Cartographic` replacement used by the Cesium compatibility layer. */
class CartographicImpl {
    constructor(public longitude: number = 0, public latitude: number = 0, public height: number = 0) {}

    /** Creates a cartographic position from degree input. */
    static fromDegrees(longitudeDegrees: number, latitudeDegrees: number, heightMeters: number = 0): CartographicImpl {
        return new CartographicImpl(longitudeDegrees * DEG_TO_RAD, latitudeDegrees * DEG_TO_RAD, heightMeters);
    }

    /** Creates a cartographic position from radian input. */
    static fromRadians(longitude: number, latitude: number, heightMeters: number = 0): CartographicImpl {
        return new CartographicImpl(longitude, latitude, heightMeters);
    }

    /** Converts the simplified cartesian representation back to longitude, latitude, and height. */
    static fromCartesian(cartesian: Cartesian3Impl): CartographicImpl {
        const lon = Math.atan2(cartesian.y, cartesian.x);
        const horizontal = Math.sqrt(cartesian.x * cartesian.x + cartesian.y * cartesian.y);
        const lat = Math.atan2(cartesian.z, horizontal);
        const radius = Math.sqrt(
            cartesian.x * cartesian.x
            + cartesian.y * cartesian.y
            + cartesian.z * cartesian.z
        );
        const height = radius - EARTH_RADIUS_METERS;
        return new CartographicImpl(lon, lat, height);
    }
}

/** Minimal rectangle helper used for viewport tests and extent unions. */
class RectangleImpl {
    constructor(
        public west: number = 0,
        public south: number = 0,
        public east: number = 0,
        public north: number = 0
    ) {}

    /** Creates a rectangle from degree input. */
    static fromDegrees(westDegrees: number, southDegrees: number, eastDegrees: number, northDegrees: number): RectangleImpl {
        return new RectangleImpl(
            westDegrees * DEG_TO_RAD,
            southDegrees * DEG_TO_RAD,
            eastDegrees * DEG_TO_RAD,
            northDegrees * DEG_TO_RAD
        );
    }

    /** Returns the union of two rectangles. */
    static union(lhs: RectangleImpl, rhs: RectangleImpl, result?: RectangleImpl | null): RectangleImpl {
        const out = result ?? new RectangleImpl();
        out.west = Math.min(lhs.west, rhs.west);
        out.south = Math.min(lhs.south, rhs.south);
        out.east = Math.max(lhs.east, rhs.east);
        out.north = Math.max(lhs.north, rhs.north);
        return out;
    }

    /** Tests whether a point lies inside the rectangle. */
    static contains(rect: RectangleImpl, point: {longitude?: number; latitude?: number; x?: number; y?: number}): boolean {
        const longitude = typeof point.longitude === "number" ? point.longitude : point.x;
        const latitude = typeof point.latitude === "number" ? point.latitude : point.y;
        if (typeof longitude !== "number" || typeof latitude !== "number") {
            return false;
        }
        return longitude >= rect.west
            && longitude <= rect.east
            && latitude >= rect.south
            && latitude <= rect.north;
    }
}

/** Minimal color implementation with the alpha helper erdblick expects. */
class ColorImpl {
    constructor(public r: number = 1, public g: number = 1, public b: number = 1, public a: number = 1) {}

    /** Returns a copy of the color with a different alpha channel. */
    withAlpha(alpha: number): ColorImpl {
        return new ColorImpl(this.r, this.g, this.b, alpha);
    }
}

/** Lightweight collection used by the non-Cesium geo shim. */
class PrimitiveCollectionImpl {
    private readonly primitives: any[] = [];

    get length(): number {
        return this.primitives.length;
    }

    /** Adds a primitive and returns it, matching Cesium collection semantics. */
    add(primitive: any): any {
        this.primitives.push(primitive);
        return primitive;
    }

    /** Removes a primitive if present. */
    remove(primitive: any): boolean {
        const index = this.primitives.indexOf(primitive);
        if (index < 0) {
            return false;
        }
        this.primitives.splice(index, 1);
        return true;
    }
}

class BillboardCollectionImpl extends PrimitiveCollectionImpl {}
class PointPrimitiveCollectionImpl extends PrimitiveCollectionImpl {}
class LabelCollectionImpl extends PrimitiveCollectionImpl {}

class DummyClass {
    constructor(..._args: any[]) {}
}

const COLOR = ColorImpl as any;
COLOR.HOTPINK = new ColorImpl(1.0, 0.41, 0.71, 1.0);
COLOR.AQUA = new ColorImpl(0.0, 1.0, 1.0, 1.0);
COLOR.DIMGRAY = new ColorImpl(0.41, 0.41, 0.41, 1.0);
COLOR.WHITE = new ColorImpl(1.0, 1.0, 1.0, 1.0);
COLOR.GRAY = new ColorImpl(0.5, 0.5, 0.5, 1.0);
COLOR.RED = new ColorImpl(1.0, 0.0, 0.0, 1.0);
COLOR.BLUE = new ColorImpl(0.0, 0.0, 1.0, 1.0);
COLOR.YELLOW = new ColorImpl(1.0, 1.0, 0.0, 1.0);
COLOR.BLACK = new ColorImpl(0.0, 0.0, 0.0, 1.0);

const SCENE_MODE = {
    SCENE2D: 2,
    SCENE3D: 3
} as const;

const HEIGHT_REFERENCE = {
    CLAMP_TO_GROUND: "CLAMP_TO_GROUND"
} as const;

export type Cartesian2 = Cartesian2Impl;
export const Cartesian2: any = Cartesian2Impl;
export type Cartesian3 = Cartesian3Impl;
export const Cartesian3: any = Cartesian3Impl;
export type Cartographic = CartographicImpl;
export const Cartographic: any = CartographicImpl;
export type Matrix3 = any;
export const Matrix3: any = DummyClass;
export type Color = ColorImpl;
export const Color: any = COLOR;
export type GeometryInstance = any;
export const GeometryInstance: any = DummyClass;
export type Material = any;
export const Material: any = DummyClass;
export type MaterialAppearance = any;
export const MaterialAppearance: any = DummyClass;
export type PerInstanceColorAppearance = any;
export const PerInstanceColorAppearance: any = DummyClass;
export type Primitive = any;
export const Primitive: any = DummyClass;
export type RectangleGeometry = any;
export const RectangleGeometry: any = DummyClass;
export type RectangleOutlineGeometry = any;
export const RectangleOutlineGeometry: any = DummyClass;
export type ColorGeometryInstanceAttribute = any;
export const ColorGeometryInstanceAttribute: any = DummyClass;
export type ImageryLayer = any;
export const ImageryLayer: any = DummyClass;
export type ScreenSpaceEventHandler = any;
export const ScreenSpaceEventHandler: any = DummyClass;
export type ScreenSpaceEventType = any;
export const ScreenSpaceEventType: any = {};
export type UrlTemplateImageryProvider = any;
export const UrlTemplateImageryProvider: any = DummyClass;
export type Rectangle = RectangleImpl;
export const Rectangle: any = RectangleImpl;
export type HeightReference = typeof HEIGHT_REFERENCE[keyof typeof HEIGHT_REFERENCE];
export const HeightReference: any = HEIGHT_REFERENCE;
export type LabelStyle = any;
export const LabelStyle: any = {};
export type VerticalOrigin = any;
export const VerticalOrigin: any = {};
export type HorizontalOrigin = any;
export const HorizontalOrigin: any = {};
export type DistanceDisplayCondition = any;
export const DistanceDisplayCondition: any = DummyClass;
export type CallbackProperty = any;
export const CallbackProperty: any = DummyClass;
export type Viewer = any;
export const Viewer: any = DummyClass;
export type PrimitiveCollection = PrimitiveCollectionImpl;
export const PrimitiveCollection: any = PrimitiveCollectionImpl;
export type PointPrimitiveCollection = PointPrimitiveCollectionImpl;
export const PointPrimitiveCollection: any = PointPrimitiveCollectionImpl;
export type LabelCollection = LabelCollectionImpl;
export const LabelCollection: any = LabelCollectionImpl;
export type BillboardCollection = BillboardCollectionImpl;
export const BillboardCollection: any = BillboardCollectionImpl;
export type Billboard = any;
export const Billboard: any = DummyClass;
export const defined = (value: unknown): boolean => value !== undefined && value !== null;
export type PinBuilder = any;
export const PinBuilder: any = DummyClass;
export type Entity = any;
export const Entity: any = DummyClass;
export type EntityConstructorOptions = any;
export type Camera = any;
export const Camera: any = DummyClass;
export type Scene = any;
export const Scene: any = DummyClass;
export type HeadingPitchRange = any;
export const HeadingPitchRange: any = DummyClass;
export type BoundingSphere = any;
export const BoundingSphere: any = DummyClass;
export type SceneMode = typeof SCENE_MODE[keyof typeof SCENE_MODE];
export const SceneMode: any = SCENE_MODE;
export type VertexFormat = any;
export const VertexFormat: any = {};
export type WebMercatorProjection = any;
export const WebMercatorProjection: any = DummyClass;
export type GeographicProjection = any;
export const GeographicProjection: any = DummyClass;
export type Ellipsoid = any;
export const Ellipsoid: any = DummyClass;
export type PerspectiveFrustum = any;
export const PerspectiveFrustum: any = DummyClass;
export type KeyboardEventModifier = any;
export const KeyboardEventModifier: any = {};
export const EasingFunction: any = {};
export type ColorMaterialProperty = any;
export const ColorMaterialProperty: any = DummyClass;
export type JulianDate = any;
export const JulianDate: any = DummyClass;

export const GeoMath = {
    /** Converts degrees to radians. */
    toRadians(value: number): number {
        return value * DEG_TO_RAD;
    },
    /** Converts radians to degrees. */
    toDegrees(value: number): number {
        return value * RAD_TO_DEG;
    }
};
