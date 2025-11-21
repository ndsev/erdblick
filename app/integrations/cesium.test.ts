// Test-only Cesium integration for Vitest unit tests.
// This variant imports the Cesium ESM entry point so tests can access the
// full engine API without relying on the global UMD bundle. It is only
// used in the "test" build configuration via fileReplacements in
// angular.json and is never part of the production bundle.

import * as Cesium from "cesium";

export type Cartesian2 = Cesium.Cartesian2;
export const Cartesian2 = Cesium.Cartesian2;
export type Cartesian3 = Cesium.Cartesian3;
export const Cartesian3 = Cesium.Cartesian3;
export type Cartographic = Cesium.Cartographic;
export const Cartographic = Cesium.Cartographic;
export type Matrix3 = Cesium.Matrix3;
export const Matrix3 = Cesium.Matrix3;
export type Color = Cesium.Color;
export const Color = Cesium.Color;
export type GeometryInstance = Cesium.GeometryInstance;
export const GeometryInstance = Cesium.GeometryInstance;
export type PerInstanceColorAppearance = Cesium.PerInstanceColorAppearance;
export const PerInstanceColorAppearance = Cesium.PerInstanceColorAppearance;
export type Primitive = Cesium.Primitive;
export const Primitive = Cesium.Primitive;
export type RectangleGeometry = Cesium.RectangleGeometry;
export const RectangleGeometry = Cesium.RectangleGeometry;
export type RectangleOutlineGeometry = Cesium.RectangleOutlineGeometry;
export const RectangleOutlineGeometry = Cesium.RectangleOutlineGeometry;
export type ColorGeometryInstanceAttribute = Cesium.ColorGeometryInstanceAttribute;
export const ColorGeometryInstanceAttribute = Cesium.ColorGeometryInstanceAttribute;
export type ImageryLayer = Cesium.ImageryLayer;
export const ImageryLayer = Cesium.ImageryLayer;
export type ScreenSpaceEventHandler = Cesium.ScreenSpaceEventHandler;
export const ScreenSpaceEventHandler = Cesium.ScreenSpaceEventHandler;
export type ScreenSpaceEventType = Cesium.ScreenSpaceEventType;
export const ScreenSpaceEventType = Cesium.ScreenSpaceEventType;
export type UrlTemplateImageryProvider = Cesium.UrlTemplateImageryProvider;
export const UrlTemplateImageryProvider = Cesium.UrlTemplateImageryProvider;
export type Rectangle = Cesium.Rectangle;
export const Rectangle = Cesium.Rectangle;
export type HeightReference = Cesium.HeightReference;
export const HeightReference = Cesium.HeightReference;
export type LabelStyle = Cesium.LabelStyle;
export const LabelStyle = Cesium.LabelStyle;
export type VerticalOrigin = Cesium.VerticalOrigin;
export const VerticalOrigin = Cesium.VerticalOrigin;
export type HorizontalOrigin = Cesium.HorizontalOrigin;
export const HorizontalOrigin = Cesium.HorizontalOrigin;
export type DistanceDisplayCondition = Cesium.DistanceDisplayCondition;
export const DistanceDisplayCondition = Cesium.DistanceDisplayCondition;
export type CallbackProperty = Cesium.CallbackProperty;
export const CallbackProperty = Cesium.CallbackProperty;
export type Viewer = Cesium.Viewer;
export const Viewer = Cesium.Viewer;
export type PrimitiveCollection = Cesium.PrimitiveCollection;
export const PrimitiveCollection = Cesium.PrimitiveCollection;
export type PointPrimitiveCollection = Cesium.PointPrimitiveCollection;
export const PointPrimitiveCollection = Cesium.PointPrimitiveCollection;
export type LabelCollection = Cesium.LabelCollection;
export const LabelCollection = Cesium.LabelCollection;
export type BillboardCollection = Cesium.BillboardCollection;
export const BillboardCollection = Cesium.BillboardCollection;
export type Billboard = Cesium.Billboard;
export const Billboard = Cesium.Billboard;
export const defined = Cesium.defined;
export type PinBuilder = Cesium.PinBuilder;
export type Entity = Cesium.Entity;
export const Entity = Cesium.Entity;
export type EntityConstructorOptions = Cesium.Entity.ConstructorOptions;
export type Camera = Cesium.Camera;
export const Camera = Cesium.Camera;
export type Scene = Cesium.Scene;
export const Scene = Cesium.Scene;
export type HeadingPitchRange = Cesium.HeadingPitchRange;
export const HeadingPitchRange = Cesium.HeadingPitchRange;
export type BoundingSphere = Cesium.BoundingSphere;
export const BoundingSphere = Cesium.BoundingSphere;
export type SceneMode = Cesium.SceneMode;
export const SceneMode = Cesium.SceneMode;
export type WebMercatorProjection = Cesium.WebMercatorProjection;
export const WebMercatorProjection = Cesium.WebMercatorProjection;
export type GeographicProjection = Cesium.GeographicProjection;
export const GeographicProjection = Cesium.GeographicProjection;
export type Ellipsoid = Cesium.Ellipsoid;
export const Ellipsoid = Cesium.Ellipsoid;
export type PerspectiveFrustum = Cesium.PerspectiveFrustum;
export const PerspectiveFrustum = Cesium.PerspectiveFrustum;
export type KeyboardEventModifier = Cesium.KeyboardEventModifier;
export const KeyboardEventModifier = Cesium.KeyboardEventModifier;
export const EasingFunction = Cesium.EasingFunction;
export type ColorMaterialProperty = Cesium.ColorMaterialProperty;
export const ColorMaterialProperty = Cesium.ColorMaterialProperty;
export type JulianDate = Cesium.JulianDate;
export const JulianDate = Cesium.JulianDate;

// Math is a namespace.
export const CesiumMath = Cesium.Math;

