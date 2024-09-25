// This file allows us to use ESM-Style Imports in the
// rest of the erdblick code. However, we instruct webpack to ignore
// the cesium import. Instead, Cesium is provided via its
// non-ESM distribution, because it has inline workers.
// See: https://github.com/CesiumGS/cesium/pull/11519
// In index.js, we have the Cesium.js import, so Cesium is
// available as a global variable.

import * as Cesium from "cesium";

// Add aliases for any required types. Wherever the type
// has a static function, such as Cartesian3.fromDegrees,
// it must also be exported as a const.

export type  Cartesian2 = Cesium.Cartesian2;
export const Cartesian2 = Cesium.Cartesian2;
export type  Cartesian3 = Cesium.Cartesian3;
export const Cartesian3 = Cesium.Cartesian3;
export type  Cartographic = Cesium.Cartographic;
export const Cartographic = Cesium.Cartographic;
export type  Matrix3 = Cesium.Matrix3;
export const Matrix3 = Cesium.Matrix3;
export type  Color = Cesium.Color;
export const Color = Cesium.Color;
export type  ColorGeometryInstanceAttribute = Cesium.ColorGeometryInstanceAttribute;
export const ColorGeometryInstanceAttribute = Cesium.ColorGeometryInstanceAttribute;
export type  ImageryLayer = Cesium.ImageryLayer;
export const ImageryLayer = Cesium.ImageryLayer;
export type  ScreenSpaceEventHandler = Cesium.ScreenSpaceEventHandler;
export const ScreenSpaceEventHandler = Cesium.ScreenSpaceEventHandler;
export type  ScreenSpaceEventType = Cesium.ScreenSpaceEventType;
export const ScreenSpaceEventType = Cesium.ScreenSpaceEventType;
export type  UrlTemplateImageryProvider = Cesium.UrlTemplateImageryProvider;
export const UrlTemplateImageryProvider = Cesium.UrlTemplateImageryProvider;
export type  Rectangle = Cesium.Rectangle;
export const Rectangle = Cesium.Rectangle;
export type  HeightReference = Cesium.HeightReference;
export const HeightReference = Cesium.HeightReference;
export type  LabelStyle = Cesium.LabelStyle;
export const LabelStyle = Cesium.LabelStyle;
export type  VerticalOrigin = Cesium.VerticalOrigin;
export const VerticalOrigin = Cesium.VerticalOrigin;
export type  HorizontalOrigin = Cesium.HorizontalOrigin;
export const HorizontalOrigin = Cesium.HorizontalOrigin;
export type  DistanceDisplayCondition = Cesium.DistanceDisplayCondition;
export const DistanceDisplayCondition = Cesium.DistanceDisplayCondition;
export type  CallbackProperty = Cesium.CallbackProperty;
export const CallbackProperty = Cesium.CallbackProperty;
export type  Viewer = Cesium.Viewer;
export const Viewer = Cesium.Viewer;
export type  PrimitiveCollection = Cesium.PrimitiveCollection;
export const PrimitiveCollection = Cesium.PrimitiveCollection;
export type  PointPrimitiveCollection = Cesium.PointPrimitiveCollection;
export const PointPrimitiveCollection = Cesium.PointPrimitiveCollection;
export type  LabelCollection = Cesium.LabelCollection;
export const LabelCollection = Cesium.LabelCollection;
export type  BillboardCollection = Cesium.BillboardCollection;
export const BillboardCollection = Cesium.BillboardCollection;
export type  Billboard = Cesium.Billboard;
export const Billboard = Cesium.Billboard;
export const defined = Cesium.defined;
export type  PinBuilder = Cesium.PinBuilder;
export type  Entity = Cesium.Entity;
export const Entity = Cesium.Entity;
export type  Camera = Cesium.Camera;
export const Camera = Cesium.Camera;
export type HeadingPitchRange = Cesium.HeadingPitchRange;
export const HeadingPitchRange = Cesium.HeadingPitchRange;
export type BoundingSphere = Cesium.BoundingSphere;
export const BoundingSphere = Cesium.BoundingSphere;

// Math is a namespace.

export const CesiumMath = Cesium.Math;
