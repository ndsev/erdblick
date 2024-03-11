#include <map>
#include <iostream>
#include "cesium-interface/primitive.h"
#include "cesium-interface/cesium.h"
#include "cesium-interface/point-conversion.h"

namespace erdblick {


CesiumPrimitive CesiumPrimitive::withLabelCollection() {
    CesiumPrimitive result;
    result.labelCollection_ = Cesium().LabelCollection.New();
    return result;
}

CesiumPrimitive CesiumPrimitive::withPolylineColorAppearance(bool clampToGround) {
    CesiumPrimitive result;
    result.appearance_ = Cesium().PolylineColorAppearance.New();
    result.clampToGround_ = clampToGround;
    result.polyLinePrimitive_ = true;
    result.perInstanceColor_ = true;
    return result;
}

CesiumPrimitive CesiumPrimitive::withPolylineDashMaterialAppearance(
    const FeatureStyleRule& style,
    bool clampToGround,
    glm::fvec4 const& resolvedColor)
{
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
    const FeatureStyleRule& style,
    bool clampToGround,
    glm::fvec4 const& resolvedColor)
{
    CesiumPrimitive result;
    result.appearance_ = Cesium().PolylineMaterialAppearance.New({
        {"material", Cesium().MaterialFromType("PolylineArrow", JsValue::Dict({
            {"color", Cesium().Color.New(resolvedColor.r, resolvedColor.g, resolvedColor.b, resolvedColor.a)},
        }))}
    });
    result.clampToGround_ = clampToGround;
    result.polyLinePrimitive_ = true;
    return result;
}

CesiumPrimitive CesiumPrimitive::withPerInstanceColorAppearance(
        bool flatAndSynchronous, bool clampToGround) {
    CesiumPrimitive result;
    result.flatAndSynchronous_ = flatAndSynchronous;
    result.appearance_ = Cesium().PerInstanceColorAppearance.New({
        {"flat", JsValue(flatAndSynchronous)}
    });
    result.clampToGround_ = clampToGround;
    result.polyLinePrimitive_ = false;
    result.perInstanceColor_ = true;
    return result;
}

void CesiumPrimitive::addPolyLine(
    JsValue const& vertices,
    FeatureStyleRule const& style,
    uint32_t id,
    BoundEvalFun const& evalFun)
{
    JsValue polyline;
    if (clampToGround_) {
        polyline = Cesium().GroundPolylineGeometry.New({
            {"positions", vertices},
            {"width", JsValue(style.width())}
        });
    } else {
        polyline = Cesium().PolylineGeometry.New({
            {"positions", vertices},
            {"width", JsValue(style.width())},
            {"arcType", Cesium().ArcType["NONE"]}
        });
    }
    addGeometryInstance(style, id, polyline, evalFun);
}

void CesiumPrimitive::addPolygon(
    const JsValue& vertices,
    const FeatureStyleRule& style,
    uint32_t id,
    BoundEvalFun const& evalFun)
{
    auto polygon = Cesium().PolygonGeometry.New({
        {"polygonHierarchy", Cesium().PolygonHierarchy.New(*vertices)},
        {"arcType", Cesium().ArcType["GEODESIC"]},
        {"perPositionHeight", JsValue(true)}
    });
    addGeometryInstance(style, id, polygon, evalFun);
}

void CesiumPrimitive::addTriangles(
    const JsValue& float64Array,
    const FeatureStyleRule& style,
    uint32_t id,
    BoundEvalFun const& evalFun)
{
    auto geometry = Cesium().Geometry.New({
        {"attributes", JsValue::Dict({
            {"position", Cesium().GeometryAttribute.New({
                {"componentDatatype", Cesium().ComponentDatatype["DOUBLE"]},
                {"componentsPerAttribute", JsValue(3)},
                {"values", float64Array}
            })}
        })},
        {"boundingSphere", JsValue(Cesium().BoundingSphere.call<NativeJsValue>("fromVertices", *float64Array))}
    });
    addGeometryInstance(style, id, geometry, evalFun);
}

void CesiumPrimitive::addGeometryInstance(
    const FeatureStyleRule& style,
    uint32_t id,
    const JsValue& geom,
    BoundEvalFun const& evalFun)
{
    auto attributes = JsValue::Dict();
    if (perInstanceColor_) {
        auto const color = style.color(evalFun);
        attributes.set(
            "color",
            Cesium().ColorGeometryInstanceAttribute.New(color.r, color.g, color.b, color.a));
    }
    auto geometryInstance = Cesium().GeometryInstance.New({
        {"geometry", geom},
        {"id", JsValue(id)},
        {"attributes", attributes}
    });
    ++numGeometryInstances_;
    geometryInstances_.push(geometryInstance);
}


void CesiumPrimitive::addLabel(
        JsValue const &position,
        std::string labelText,
        FeatureStyleRule const &style,
        uint32_t id) {
    JsValue label;
    label = Cesium().PolylineGeometry.New({
         {"position", position},
         {"show", JsValue(true)},
         {"text", JsValue(labelText)},
         {"font", JsValue(style())},
         {"arcType", Cesium().ArcType["NONE"]}
    });
    this->labelCollection_.push(label);
}

NativeJsValue CesiumPrimitive::toJsObject() const {
    JsValue result;
    auto primitiveOptions = JsValue::Dict({
        {"geometryInstances", geometryInstances_},
        {"appearance", appearance_},
        {"releaseGeometryInstances", JsValue(true)},
        {"asynchronous", JsValue(!flatAndSynchronous_)}
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
