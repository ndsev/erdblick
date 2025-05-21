#include <map>
#include <iostream>
#include "cesium-interface/primitive.h"
#include "cesium-interface/cesium.h"
#include "cesium-interface/point-conversion.h"

namespace erdblick {

CesiumPrimitive CesiumPrimitive::withPolylineColorAppearance(bool clampToGround) {
    CesiumPrimitive result;
    result.appearance_ = Cesium().PolylineColorAppearance.New();
    result.clampToGround_ = clampToGround;
    result.polyLinePrimitive_ = true;
    result.perInstanceColor_ = true;
    // Allow async, otherwise we need to run initializeTerrainHeights() for ground primitives
    result.synchronous_ = !clampToGround;
    return result;
}

CesiumPrimitive CesiumPrimitive::withPolylineDashMaterialAppearance(
        const FeatureStyleRule &style,
        bool clampToGround,
        glm::fvec4 const &resolvedColor) {
    CesiumPrimitive result;
    auto const &gapColor = style.gapColor();
    result.appearance_ = Cesium().PolylineMaterialAppearance.New({
        {"material", Cesium().MaterialFromType("PolylineDash", JsValue::Dict({
            {"color", Cesium().Color.New(resolvedColor.r, resolvedColor.g, resolvedColor.b, resolvedColor.a)},
            {"gapColor", Cesium().Color.New(gapColor.r, gapColor.g, gapColor.b, gapColor.a)},
            {"dashLength", JsValue(style.dashLength())},
            {"dashPattern", JsValue(style.dashPattern())}
        }))}
    });
    result.clampToGround_ = clampToGround;
    result.polyLinePrimitive_ = true;
    return result;
}

CesiumPrimitive CesiumPrimitive::withPolylineArrowMaterialAppearance(
        const FeatureStyleRule &style,
        bool clampToGround,
        glm::fvec4 const &resolvedColor) {
    CesiumPrimitive result;
    result.appearance_ = Cesium().PolylineMaterialAppearance.New({
        {"material", Cesium().MaterialFromType("PolylineArrow", JsValue::Dict({
            {"color", Cesium().Color.New(resolvedColor.r, resolvedColor.g, resolvedColor.b, resolvedColor.a)}
        }))}
    });
    result.clampToGround_ = clampToGround;
    result.polyLinePrimitive_ = true;
    return result;
}

CesiumPrimitive CesiumPrimitive::withPerInstanceColorAppearance(bool flatAndSynchronous, bool clampToGround) {
    CesiumPrimitive result;
    result.synchronous_ = flatAndSynchronous;
    result.appearance_ = Cesium().PerInstanceColorAppearance.New({
         {"flat", JsValue(flatAndSynchronous)}
    });
    result.clampToGround_ = clampToGround;
    result.polyLinePrimitive_ = false;
    result.perInstanceColor_ = true;
    return result;
}

void CesiumPrimitive::addPolyLine(
        JsValue const &vertices,
        FeatureStyleRule const &style,
        JsValue const& id,
        BoundEvalFun const &evalFun) {
    JsValue polylineArgs;
    CesiumClass* polylineClass = nullptr;
    if (clampToGround_) {
        polylineClass = &Cesium().GroundPolylineGeometry;
        polylineArgs = JsValue::Dict({
            {"positions", vertices},
            {"width",     JsValue(style.width())}
       });
    } else {
        polylineClass = &Cesium().PolylineGeometry;
        polylineArgs = JsValue::Dict({
            {"positions", vertices},
            {"width",     JsValue(style.width())},
            {"arcType",   Cesium().ArcType["NONE"]}
        });
    }
    auto polyline = polylineClass->New(polylineArgs);
    if (synchronous_) {
        polyline = JsValue(polylineClass->call("createGeometry", polyline));
    }
    if (polyline.type() > JsValue::Type::Null) {
        addGeometryInstance(style, id, polyline, evalFun);
    }
}

void CesiumPrimitive::addPolygon(
        const JsValue &vertices,
        const FeatureStyleRule &style,
        JsValue const& id,
        BoundEvalFun const &evalFun) {
    auto polygon = Cesium().PolygonGeometry.New({
        {"polygonHierarchy",  Cesium().PolygonHierarchy.New(*vertices)},
        {"arcType",           Cesium().ArcType["GEODESIC"]},
        {"perPositionHeight", JsValue(true)}
    });
    addGeometryInstance(style, id, polygon, evalFun);
}

void CesiumPrimitive::addTriangles(
        const JsValue &float64Array,
        const FeatureStyleRule &style,
        JsValue const& id,
        BoundEvalFun const &evalFun) {
    auto geometry = Cesium().Geometry.New({
        {"attributes", JsValue::Dict({
            {"position", Cesium().GeometryAttribute.New({
                {"componentDatatype",      Cesium().ComponentDatatype["DOUBLE"]},
                {"componentsPerAttribute", JsValue(3)},
                {"values",                 float64Array}
            })}
        })},
        {"boundingSphere", JsValue(Cesium().BoundingSphere.call<NativeJsValue>("fromVertices", *float64Array))}
    });
    addGeometryInstance(style, id, geometry, evalFun);
}

void CesiumPrimitive::addGeometryInstance(
        const FeatureStyleRule &style,
        JsValue const& id,
        const JsValue &geom,
        BoundEvalFun const &evalFun) {
    auto attributes = JsValue::Dict();
    if (perInstanceColor_) {
        auto const color = style.color(evalFun);
        attributes.set("color", Cesium().ColorGeometryInstanceAttribute.New(color.r, color.g, color.b, color.a));
    }
    auto geometryInstance = Cesium().GeometryInstance.New({
        {"geometry",   geom},
        {"id",         id},
        {"attributes", attributes}
    });
    ++numGeometryInstances_;
    geometryInstances_.push(geometryInstance);
}

NativeJsValue CesiumPrimitive::toJsObject() const {
    JsValue result;

    auto primitiveOptions = JsValue::Dict({
        {"geometryInstances",        geometryInstances_},
        {"appearance",               appearance_},
        {"releaseGeometryInstances", JsValue(true)},
        {"asynchronous",             JsValue(!synchronous_)}
    });

    if (clampToGround_ && polyLinePrimitive_)
        result = Cesium().GroundPolylinePrimitive.New(*primitiveOptions);
    else if (clampToGround_)
        result = Cesium().GroundPrimitive.New(*primitiveOptions);
    else
        result = Cesium().Primitive.New(*primitiveOptions);

    return *result;
}

bool CesiumPrimitive::empty() const {
    return numGeometryInstances_ == 0;
}

}