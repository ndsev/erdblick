// This file allows us to use ESM-style imports in the
// rest of the erdblick code, while relying on the global
// Cesium UMD bundle included in index.html. Importing the
// runtime module would pull in CommonJS dependencies from
// @cesium/* and trigger optimization bailouts.
//
// We therefore only use type information from the "cesium"
// package and reference the global `Cesium` at runtime.
// The following import provides full typings without causing
// a runtime import or bundling.
import type * as CesiumType from "cesium";
declare const Cesium: typeof CesiumType;

// Add aliases for any required types. Wherever the type
// has a static function, such as Cartesian3.fromDegrees,
// it must also be exported as a const.

export type  Cartesian2 = CesiumType.Cartesian2;
export const Cartesian2 = Cesium.Cartesian2;
export type  Cartesian3 = CesiumType.Cartesian3;
export const Cartesian3 = Cesium.Cartesian3;
export type  Cartographic = CesiumType.Cartographic;
export const Cartographic = Cesium.Cartographic;
export type  Matrix3 = CesiumType.Matrix3;
export const Matrix3 = Cesium.Matrix3;
export type  Color = CesiumType.Color;
export const Color = Cesium.Color;
export type GeometryInstance = CesiumType.GeometryInstance;
export const GeometryInstance = Cesium.GeometryInstance;
export type PerInstanceColorAppearance = CesiumType.PerInstanceColorAppearance;
export const PerInstanceColorAppearance = Cesium.PerInstanceColorAppearance;
export type Primitive = CesiumType.Primitive;
export const Primitive = Cesium.Primitive;
export type RectangleGeometry = CesiumType.RectangleGeometry;
export const RectangleGeometry = Cesium.RectangleGeometry;
export type RectangleOutlineGeometry = CesiumType.RectangleOutlineGeometry;
export const RectangleOutlineGeometry = Cesium.RectangleOutlineGeometry;
export type  ColorGeometryInstanceAttribute = CesiumType.ColorGeometryInstanceAttribute;
export const ColorGeometryInstanceAttribute = Cesium.ColorGeometryInstanceAttribute;
export type  ImageryLayer = CesiumType.ImageryLayer;
export const ImageryLayer = Cesium.ImageryLayer;
export type  ScreenSpaceEventHandler = CesiumType.ScreenSpaceEventHandler;
export const ScreenSpaceEventHandler = Cesium.ScreenSpaceEventHandler;
export type  ScreenSpaceEventType = CesiumType.ScreenSpaceEventType;
export const ScreenSpaceEventType = Cesium.ScreenSpaceEventType;
export type  UrlTemplateImageryProvider = CesiumType.UrlTemplateImageryProvider;
export const UrlTemplateImageryProvider = Cesium.UrlTemplateImageryProvider;
export type  Rectangle = CesiumType.Rectangle;
export const Rectangle = Cesium.Rectangle;
export type  HeightReference = CesiumType.HeightReference;
export const HeightReference = Cesium.HeightReference;
export type  LabelStyle = CesiumType.LabelStyle;
export const LabelStyle = Cesium.LabelStyle;
export type  VerticalOrigin = CesiumType.VerticalOrigin;
export const VerticalOrigin = Cesium.VerticalOrigin;
export type  HorizontalOrigin = CesiumType.HorizontalOrigin;
export const HorizontalOrigin = Cesium.HorizontalOrigin;
export type  DistanceDisplayCondition = CesiumType.DistanceDisplayCondition;
export const DistanceDisplayCondition = Cesium.DistanceDisplayCondition;
export type  CallbackProperty = CesiumType.CallbackProperty;
export const CallbackProperty = Cesium.CallbackProperty;
export type  Viewer = CesiumType.Viewer;
export const Viewer = Cesium.Viewer;
export type  PrimitiveCollection = CesiumType.PrimitiveCollection;
export const PrimitiveCollection = Cesium.PrimitiveCollection;
export type  PointPrimitiveCollection = CesiumType.PointPrimitiveCollection;
export const PointPrimitiveCollection = Cesium.PointPrimitiveCollection;
export type  LabelCollection = CesiumType.LabelCollection;
export const LabelCollection = Cesium.LabelCollection;
export type  BillboardCollection = CesiumType.BillboardCollection;
export const BillboardCollection = Cesium.BillboardCollection;
export type  Billboard = CesiumType.Billboard;
export const Billboard = Cesium.Billboard;
export const defined = Cesium.defined;
export type  PinBuilder = CesiumType.PinBuilder;
export type  Entity = CesiumType.Entity;
export const Entity = Cesium.Entity;
export type  EntityConstructorOptions = CesiumType.Entity.ConstructorOptions;
export type  Camera = CesiumType.Camera;
export const Camera = Cesium.Camera;
export type  Scene = CesiumType.Scene;
export const Scene = Cesium.Scene;
export type HeadingPitchRange = CesiumType.HeadingPitchRange;
export const HeadingPitchRange = Cesium.HeadingPitchRange;
export type BoundingSphere = CesiumType.BoundingSphere;
export const BoundingSphere = Cesium.BoundingSphere;
export type SceneMode = CesiumType.SceneMode;
export const SceneMode = Cesium.SceneMode;
export type  WebMercatorProjection = CesiumType.WebMercatorProjection;
export const WebMercatorProjection = Cesium.WebMercatorProjection;
export type  GeographicProjection = CesiumType.GeographicProjection;
export const GeographicProjection = Cesium.GeographicProjection;
export type  Ellipsoid = CesiumType.Ellipsoid;
export const Ellipsoid = Cesium.Ellipsoid;
export type PerspectiveFrustum = CesiumType.PerspectiveFrustum;
export const PerspectiveFrustum = Cesium.PerspectiveFrustum;
export type KeyboardEventModifier = CesiumType.KeyboardEventModifier;
export const KeyboardEventModifier = Cesium.KeyboardEventModifier;
export const EasingFunction = Cesium.EasingFunction;
export type ColorMaterialProperty = CesiumType.ColorMaterialProperty;
export const ColorMaterialProperty = Cesium.ColorMaterialProperty;
export type JulianDate = CesiumType.JulianDate;
export const JulianDate = Cesium.JulianDate;


// Math is a namespace.

export const CesiumMath = Cesium.Math;
