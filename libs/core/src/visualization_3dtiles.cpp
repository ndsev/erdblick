#include "visualization_3dtiles.h"

#include "cesium-interface/point-conversion.h"
#include "geometry.h"

#include "nlohmann/json.hpp"
#include "CesiumGeospatial/GlobeTransforms.h"
#include "CesiumGltf/ExtensionKhrMaterialsUnlit.h"
#include "CesiumGltf/Model.h"
#include "CesiumGltfWriter/GltfWriter.h"
#include "CesiumGeometry/Transforms.h"
#include "CesiumUtility/Math.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <gsl/span>
#include <glm/gtc/type_ptr.hpp>

using namespace mapget;

namespace erdblick
{

namespace
{
std::string_view stripFeatureIdSuffix(std::string_view featureId) {
    constexpr std::string_view attributeSuffix = ":attribute#";
    constexpr std::string_view relationSuffix = ":relation#";
    auto cut = std::string_view::npos;
    if (auto pos = featureId.find(attributeSuffix); pos != std::string_view::npos) {
        cut = pos;
    }
    if (auto pos = featureId.find(relationSuffix); pos != std::string_view::npos) {
        cut = (cut == std::string_view::npos) ? pos : std::min(cut, pos);
    }
    if (cut == std::string_view::npos) {
        return featureId;
    }
    return featureId.substr(0, cut);
}

struct BufferBuilder
{
    CesiumGltf::Model& model;
    std::vector<std::byte>& data;

    static size_t align4(size_t value) {
        return (value + 3u) & ~3u;
    }

    int addBufferView(const void* src, size_t byteLength, int32_t target)
    {
        size_t aligned = align4(data.size());
        if (aligned > data.size()) {
            data.resize(aligned, std::byte{0});
        }
        size_t offset = data.size();
        data.resize(offset + byteLength);
        if (byteLength > 0) {
            std::memcpy(data.data() + offset, src, byteLength);
        }

        auto& view = model.bufferViews.emplace_back();
        view.buffer = 0;
        view.byteOffset = static_cast<int64_t>(offset);
        view.byteLength = static_cast<int64_t>(byteLength);
        view.target = target;
        return static_cast<int>(model.bufferViews.size() - 1);
    }

    int addAccessor(
        int bufferView,
        int32_t componentType,
        int64_t count,
        const std::string& type,
        std::vector<double> min = {},
        std::vector<double> max = {})
    {
        auto& accessor = model.accessors.emplace_back();
        accessor.bufferView = bufferView;
        accessor.byteOffset = 0;
        accessor.componentType = componentType;
        accessor.count = static_cast<int32_t>(count);
        accessor.type = type;
        if (!min.empty()) {
            accessor.min = std::move(min);
        }
        if (!max.empty()) {
            accessor.max = std::move(max);
        }
        return static_cast<int>(model.accessors.size() - 1);
    }
};

struct LinePrimitiveData
{
    std::vector<float> positions;
    std::vector<float> normals;
    std::vector<float> texCoord0;
    std::vector<float> texCoord1;
    std::vector<float> texCoord2;
    std::vector<float> color0;
    std::vector<float> color1;
    std::vector<uint32_t> indices;
};

struct TrianglePrimitiveData
{
    std::vector<float> positions;
    std::vector<float> normals;
    std::vector<float> texCoord0;
    std::vector<float> texCoord1;
    std::vector<float> texCoord2;
    std::vector<float> color0;
    std::vector<float> color1;
};

struct PointPrimitiveData
{
    std::vector<float> positions;
    std::vector<float> normals;
    std::vector<float> texCoord0;
    std::vector<float> texCoord1;
    std::vector<float> texCoord2;
    std::vector<float> color0;
    std::vector<float> color1;
};

struct LineStyleData
{
    glm::fvec4 color;
    glm::fvec4 gapColor;
    float widthPx = 1.0f;
    float dashLength = 0.0f;
    float dashPattern = 0.0f;
    float arrowMode = 0.0f;
};

void pushVec3(std::vector<float>& out, glm::dvec3 const& v)
{
    out.push_back(static_cast<float>(v.x));
    out.push_back(static_cast<float>(v.y));
    out.push_back(static_cast<float>(v.z));
}

void pushVec3f(std::vector<float>& out, glm::vec3 const& v)
{
    out.push_back(v.x);
    out.push_back(v.y);
    out.push_back(v.z);
}

void pushVec2(std::vector<float>& out, glm::vec2 const& v)
{
    out.push_back(v.x);
    out.push_back(v.y);
}

void pushVec4(std::vector<float>& out, glm::fvec4 const& v)
{
    out.push_back(v.r);
    out.push_back(v.g);
    out.push_back(v.b);
    out.push_back(v.a);
}

glm::vec3 normalizeOrFallback(glm::dvec3 const& v, glm::dvec3 const& fallback)
{
    auto len = glm::length(v);
    if (len < 1e-6) {
        return glm::vec3(fallback);
    }
    return glm::vec3(v / len);
}
} // namespace

FeatureLayerVisualization3DTiles::FeatureLayerVisualization3DTiles(
    int viewIndex,
    std::string const& mapTileKey,
    FeatureLayerStyle const& style,
    NativeJsValue const& rawOptionValues,
    FeatureStyleRule::HighlightMode const& highlightMode,
    NativeJsValue const& rawFeatureIdSubset)
    : viewIndex_(viewIndex),
      mapTileKey_(mapTileKey),
      style_(style),
      highlightMode_(highlightMode)
{
    // Convert option values dict to simfil values.
    auto optionValues = JsValue(rawOptionValues);
    for (auto const& option : style.options()) {
        auto stringValue = JsValue(option.defaultValue_).toString();
        simfil::Value simfilValue = simfil::Value::make(false);
        if (optionValues.has(option.id_)) {
            stringValue = optionValues[option.id_].toString();
        }
        option.convertValue(stringValue, [&simfilValue](auto&& v){
            simfilValue = simfil::Value::make(v);
        });
        optionValues_.emplace(option.id_, std::move(simfilValue));
    }

    // Convert feature ID subset.
    auto featureIdSubset = JsValue(rawFeatureIdSubset);
    for (auto i = 0; i < featureIdSubset.size(); ++i) {
        auto featureId = featureIdSubset.at(i).as<std::string>();
        featureIdSubset_.insert(featureId);
        featureIdBaseSubset_.insert(std::string(stripFeatureIdSuffix(featureId)));
    }
}

FeatureLayerVisualization3DTiles::~FeatureLayerVisualization3DTiles() = default;

void FeatureLayerVisualization3DTiles::addTileFeatureLayer(TileFeatureLayer const& tile)
{
    if (tile_) {
        return;
    }
    tile_ = tile.model_;
    internalStringPoolCopy_ = std::make_shared<simfil::StringPool>(*tile.model_->strings());
    tile_->setStrings(internalStringPoolCopy_);

    auto originWgs = tile.model_->tileId().center();
    tileOrigin_ = wgsToCartesian<glm::dvec3>(originWgs);
    enuToEcef_ = CesiumGeospatial::GlobeTransforms::eastNorthUpToFixedFrame(tileOrigin_);
    ecefToEnu_ = glm::inverse(enuToEcef_);
}

mapget::Point FeatureLayerVisualization3DTiles::origin() const
{
    return {tileOrigin_.x, tileOrigin_.y, tileOrigin_.z};
}

simfil::Value FeatureLayerVisualization3DTiles::evaluateExpression(
    const std::string& expression,
    const simfil::ModelNode& ctx,
    bool anyMode,
    bool autoWildcard) const
{
    try
    {
        auto results = tile_->evaluate(expression, ctx, anyMode, autoWildcard);
        if (!results)
            std::cout << "Error evaluating " << expression << ": " << results.error().message << std::endl;

        if (!results->values.empty()) {
            return std::move(results->values[0]);
        }
    }
    catch (std::exception const& e) {
        std::cout << "Error evaluating " << expression << ": " << e.what() << std::endl;
        return simfil::Value::null();
    }

    std::cout << "Expression " << expression << " returned nothing." << std::endl;
    return simfil::Value::null();
}

void FeatureLayerVisualization3DTiles::addOptionsToSimfilContext(simfil::model_ptr<simfil::OverlayNode>& context)
{
    for (auto const& [key, value] : optionValues_) {
        auto keyId = internalStringPoolCopy_->emplace(key);
        context->set(keyId.value(), value);
    }
}

bool FeatureLayerVisualization3DTiles::renderGlb(SharedUint8Array& result)
{
    if (!tile_) {
        return false;
    }

    LinePrimitiveData lineData;
    LinePrimitiveData lineCenterData;
    TrianglePrimitiveData triData;
    PointPrimitiveData pointData;

    boundingRadius_ = 0.0;
    hasContent_ = false;

    auto addLineGeometry = [&](std::vector<glm::dvec3> const& points,
                               LineStyleData const& style) {
        if (points.size() < 2) {
            return;
        }

        std::vector<double> cumulative;
        cumulative.reserve(points.size());
        cumulative.push_back(0.0);
        for (size_t i = 1; i < points.size(); ++i) {
            cumulative.push_back(cumulative.back() + glm::length(points[i] - points[i - 1]));
        }

        uint32_t baseIndex = static_cast<uint32_t>(lineData.positions.size() / 3);
        uint32_t centerBaseIndex = static_cast<uint32_t>(lineCenterData.positions.size() / 3);
        for (size_t i = 0; i < points.size(); ++i) {
            glm::dvec3 forward;
            if (i == 0) {
                forward = points[1] - points[0];
            } else if (i + 1 >= points.size()) {
                forward = points[i] - points[i - 1];
            } else {
                forward = points[i + 1] - points[i - 1];
            }
            glm::vec3 right = normalizeOrFallback(glm::cross(forward, glm::dvec3(0.0, 0.0, 1.0)), {1.0, 0.0, 0.0});
            glm::vec3 rightScaled = right * style.widthPx;

            auto appendVertex = [&](float side) {
                pushVec3(lineData.positions, points[i]);
                // Encode the desired pixel width in the normal length so the shader
                // can recover it even if TEXCOORD_1 isn't available.
                pushVec3f(lineData.normals, rightScaled);
                pushVec2(lineData.texCoord0, {static_cast<float>(cumulative[i]), side});
                pushVec2(lineData.texCoord1, {style.widthPx, style.dashLength});
                pushVec2(lineData.texCoord2, {style.dashPattern, style.arrowMode});
                pushVec4(lineData.color0, style.color);
                pushVec4(lineData.color1, style.gapColor);

                double r = glm::length(points[i]);
                if (r > boundingRadius_) {
                    boundingRadius_ = r;
                }
            };

            appendVertex(-1.0f);
            appendVertex(1.0f);

            // Centerline debug primitive (GL LINES). Use arrowMode = -1 to identify it in the shader.
            pushVec3(lineCenterData.positions, points[i]);
            pushVec3f(lineCenterData.normals, {0.0f, 0.0f, 1.0f});
            pushVec2(lineCenterData.texCoord0, {static_cast<float>(cumulative[i]), 0.0f});
            pushVec2(lineCenterData.texCoord1, {style.widthPx, style.dashLength});
            pushVec2(lineCenterData.texCoord2, {style.dashPattern, -1.0f});
            pushVec4(lineCenterData.color0, style.color);
            pushVec4(lineCenterData.color1, style.gapColor);
        }

        for (size_t i = 0; i + 1 < points.size(); ++i) {
            uint32_t i0 = baseIndex + static_cast<uint32_t>(i * 2);
            uint32_t i1 = i0 + 1;
            uint32_t i2 = i0 + 2;
            uint32_t i3 = i0 + 3;
            lineData.indices.push_back(i0);
            lineData.indices.push_back(i1);
            lineData.indices.push_back(i2);
            lineData.indices.push_back(i1);
            lineData.indices.push_back(i3);
            lineData.indices.push_back(i2);

            uint32_t c0 = centerBaseIndex + static_cast<uint32_t>(i);
            uint32_t c1 = c0 + 1;
            lineCenterData.indices.push_back(c0);
            lineCenterData.indices.push_back(c1);
        }
        hasContent_ = true;
    };

    auto addTriangleGeometry = [&](std::vector<glm::dvec3> const& points,
                                   glm::fvec4 const& color) {
        if (points.size() < 3) {
            return;
        }
        for (auto const& p : points) {
            pushVec3(triData.positions, p);
            pushVec3f(triData.normals, {0.0f, 0.0f, 1.0f});
            pushVec2(triData.texCoord0, {0.0f, 0.0f});
            pushVec2(triData.texCoord1, {0.0f, 0.0f});
            pushVec2(triData.texCoord2, {0.0f, 0.0f});
            pushVec4(triData.color0, color);
            pushVec4(triData.color1, {0.0f, 0.0f, 0.0f, 0.0f});

            double r = glm::length(p);
            if (r > boundingRadius_) {
                boundingRadius_ = r;
            }
        }
        hasContent_ = true;
    };

    auto addPointGeometry = [&](glm::dvec3 const& p, glm::fvec4 const& color, float sizePx) {
        pushVec3(pointData.positions, p);
        // Encode point size in the normal length for the same reason as lines.
        pushVec3f(pointData.normals, {sizePx, 0.0f, 0.0f});
        pushVec2(pointData.texCoord0, {0.0f, 0.0f});
        pushVec2(pointData.texCoord1, {sizePx, 0.0f});
        pushVec2(pointData.texCoord2, {0.0f, 0.0f});
        pushVec4(pointData.color0, color);
        pushVec4(pointData.color1, {0.0f, 0.0f, 0.0f, 0.0f});

        double r = glm::length(p);
        if (r > boundingRadius_) {
            boundingRadius_ = r;
        }
        hasContent_ = true;
    };

    auto processFeature = [&](mapget::model_ptr<mapget::Feature>& feature)
    {
        auto const& constFeature = static_cast<mapget::Feature const&>(*feature);
        auto evaluationContext = simfil::model_ptr<simfil::OverlayNode>::make(simfil::Value::field(constFeature));
        addOptionsToSimfilContext(evaluationContext);
        auto boundEvalFun = BoundEvalFun{
            evaluationContext,
            [this, &evaluationContext](auto&& str)
            {
                return evaluateExpression(str, *evaluationContext, false, false);
            }};

        auto const& candidateRuleIndices =
            style_.candidateRuleIndices(highlightMode_, constFeature.typeId());
        uint32_t featureGeomMask = 0;
        bool needsFeatureGeomMask = false;
        for (auto ruleIndex : candidateRuleIndices) {
            if (style_.rules()[ruleIndex].aspect() == FeatureStyleRule::Feature) {
                needsFeatureGeomMask = true;
                break;
            }
        }
        if (needsFeatureGeomMask) {
            if (auto geom = feature->geomOrNull()) {
                geom->forEachGeometry([&featureGeomMask](auto&& geomEntry) {
                    featureGeomMask |= (1u << static_cast<std::underlying_type_t<mapget::GeomType>>(geomEntry->geomType()));
                    return true;
                });
            }
        }
        for (auto ruleIndex : candidateRuleIndices) {
            auto const& rule = style_.rules()[ruleIndex];
            if (rule.aspect() == FeatureStyleRule::Feature) {
                if ((featureGeomMask & rule.geometryTypesMask()) == 0) {
                    continue;
                }
            }
            if (auto* matchingSubRule = rule.match(*feature, boundEvalFun)) {
                auto offset = localWgs84UnitCoordinateSystem(feature->firstGeometry()) * matchingSubRule->offset();

                feature->geom()->forEachGeometry(
                    [&](auto&& geom)
                    {
                        if (!matchingSubRule->supports(geom->geomType(), geom->name()))
                            return true;

                        std::vector<glm::dvec3> vertsLocal;
                        auto pointCount = geom->numPoints();
                        vertsLocal.reserve(pointCount);

                        for (size_t i = 0; i < pointCount; ++i) {
                            auto vertCarto = geom->pointAt(i);
                            auto adjusted = vertCarto;
                            if (matchingSubRule->flat()) {
                                adjusted.z = 0.0;
                            }
                            auto cartesian = wgsToCartesian<glm::dvec3>(adjusted, offset);
                            auto local = ecefToEnu_ * glm::dvec4(cartesian, 1.0);
                            vertsLocal.emplace_back(local);
                        }

                        switch (geom->geomType()) {
                        case GeomType::Line: {
                            LineStyleData styleData;
                            styleData.color = matchingSubRule->color(boundEvalFun);
                            styleData.widthPx = matchingSubRule->width();
                            styleData.gapColor = matchingSubRule->gapColor();
                            styleData.dashLength = static_cast<float>(matchingSubRule->dashLength());
                            styleData.dashPattern = static_cast<float>(matchingSubRule->isDashed() ? matchingSubRule->dashPattern() : 0);
                            styleData.arrowMode = static_cast<float>(matchingSubRule->arrow(boundEvalFun));
                            addLineGeometry(vertsLocal, styleData);
                            break;
                        }
                        case GeomType::Mesh: {
                            glm::fvec4 color = matchingSubRule->color(boundEvalFun);
                            addTriangleGeometry(vertsLocal, color);
                            break;
                        }
                        case GeomType::Polygon: {
                            // Render polygon outlines for now.
                            if (vertsLocal.size() >= 2) {
                                if (vertsLocal.front() != vertsLocal.back()) {
                                    vertsLocal.push_back(vertsLocal.front());
                                }
                                LineStyleData styleData;
                                styleData.color = matchingSubRule->color(boundEvalFun);
                                styleData.widthPx = matchingSubRule->width();
                                styleData.gapColor = matchingSubRule->gapColor();
                                styleData.dashLength = static_cast<float>(matchingSubRule->dashLength());
                                styleData.dashPattern = static_cast<float>(matchingSubRule->isDashed() ? matchingSubRule->dashPattern() : 0);
                                styleData.arrowMode = 0.0f;
                                addLineGeometry(vertsLocal, styleData);
                            }
                            break;
                        }
                        case GeomType::Points: {
                            glm::fvec4 color = matchingSubRule->color(boundEvalFun);
                            float sizePx = matchingSubRule->width();
                            for (auto const& pt : vertsLocal) {
                                addPointGeometry(pt, color, sizePx);
                            }
                            break;
                        }
                        }
                        return true;
                    });
            }
        }
    };

    if (featureIdBaseSubset_.empty()) {
        for (auto&& feature : *tile_) {
            processFeature(feature);
        }
    } else {
        for (auto const& featureId : featureIdBaseSubset_) {
            if (auto feature = tile_->find(featureId)) {
                processFeature(feature);
            }
        }
    }

    if (!hasContent_) {
        return false;
    }

    CesiumGltf::Model model;
    model.asset.version = "2.0";
    model.asset.generator = "erdblick-3dtiles";
    // Leave glTF up-axis unspecified; the model coordinates are already in ENU (Z-up),
    // and the tileset root transform maps them into ECEF without additional rotation.

    model.scenes.emplace_back();
    model.scene = 0;

    auto& node = model.nodes.emplace_back();
    node.mesh = 0;
    model.scenes[0].nodes.push_back(0);

    auto& mesh = model.meshes.emplace_back();

    // Single shared unlit material.
    auto& material = model.materials.emplace_back();
    material.pbrMetallicRoughness = CesiumGltf::MaterialPBRMetallicRoughness();
    material.pbrMetallicRoughness->baseColorFactor = {1.0, 1.0, 1.0, 1.0};
    material.pbrMetallicRoughness->metallicFactor = 0.0;
    material.pbrMetallicRoughness->roughnessFactor = 1.0;
    material.alphaMode = CesiumGltf::Material::AlphaMode::BLEND;
    material.doubleSided = true;
    material.addExtension<CesiumGltf::ExtensionKhrMaterialsUnlit>();
    model.extensionsUsed.emplace_back(CesiumGltf::ExtensionKhrMaterialsUnlit::ExtensionName);

    model.buffers.emplace_back();
    auto& buffer = model.buffers.back().cesium.data;
    BufferBuilder builder{model, buffer};

    auto addPrimitiveCommon = [&](CesiumGltf::MeshPrimitive& prim,
                                  std::vector<float> const& positions,
                                  std::vector<float> const& normals,
                                  std::vector<float> const& tex0,
                                  std::vector<float> const& tex1,
                                  std::vector<float> const& tex2,
                                  std::vector<float> const& col0,
                                  std::vector<float> const& col1) {
        if (positions.empty()) {
            return;
        }
        auto posView = builder.addBufferView(
            positions.data(),
            positions.size() * sizeof(float),
            CesiumGltf::BufferView::Target::ARRAY_BUFFER);
        int64_t posCount = static_cast<int64_t>(positions.size() / 3);

        glm::vec3 minv{std::numeric_limits<float>::max()};
        glm::vec3 maxv{-std::numeric_limits<float>::max()};
        for (size_t i = 0; i < positions.size(); i += 3) {
            minv.x = std::min(minv.x, positions[i]);
            minv.y = std::min(minv.y, positions[i + 1]);
            minv.z = std::min(minv.z, positions[i + 2]);
            maxv.x = std::max(maxv.x, positions[i]);
            maxv.y = std::max(maxv.y, positions[i + 1]);
            maxv.z = std::max(maxv.z, positions[i + 2]);
        }
        auto posAccessor = builder.addAccessor(
            posView,
            CesiumGltf::Accessor::ComponentType::FLOAT,
            posCount,
            CesiumGltf::Accessor::Type::VEC3,
            {minv.x, minv.y, minv.z},
            {maxv.x, maxv.y, maxv.z});
        prim.attributes["POSITION"] = posAccessor;

        auto normalView = builder.addBufferView(
            normals.data(),
            normals.size() * sizeof(float),
            CesiumGltf::BufferView::Target::ARRAY_BUFFER);
        auto normalAccessor = builder.addAccessor(
            normalView,
            CesiumGltf::Accessor::ComponentType::FLOAT,
            posCount,
            CesiumGltf::Accessor::Type::VEC3);
        prim.attributes["NORMAL"] = normalAccessor;
        prim.attributes["_NORMALMC"] = normalAccessor;

        auto tex0View = builder.addBufferView(
            tex0.data(),
            tex0.size() * sizeof(float),
            CesiumGltf::BufferView::Target::ARRAY_BUFFER);
        auto tex0Accessor = builder.addAccessor(
            tex0View,
            CesiumGltf::Accessor::ComponentType::FLOAT,
            posCount,
            CesiumGltf::Accessor::Type::VEC2);
        prim.attributes["TEXCOORD_0"] = tex0Accessor;

        auto tex1View = builder.addBufferView(
            tex1.data(),
            tex1.size() * sizeof(float),
            CesiumGltf::BufferView::Target::ARRAY_BUFFER);
        auto tex1Accessor = builder.addAccessor(
            tex1View,
            CesiumGltf::Accessor::ComponentType::FLOAT,
            posCount,
            CesiumGltf::Accessor::Type::VEC2);
        prim.attributes["TEXCOORD_1"] = tex1Accessor;

        auto tex2View = builder.addBufferView(
            tex2.data(),
            tex2.size() * sizeof(float),
            CesiumGltf::BufferView::Target::ARRAY_BUFFER);
        auto tex2Accessor = builder.addAccessor(
            tex2View,
            CesiumGltf::Accessor::ComponentType::FLOAT,
            posCount,
            CesiumGltf::Accessor::Type::VEC2);
        prim.attributes["TEXCOORD_2"] = tex2Accessor;

        auto col0View = builder.addBufferView(
            col0.data(),
            col0.size() * sizeof(float),
            CesiumGltf::BufferView::Target::ARRAY_BUFFER);
        auto col0Accessor = builder.addAccessor(
            col0View,
            CesiumGltf::Accessor::ComponentType::FLOAT,
            posCount,
            CesiumGltf::Accessor::Type::VEC4);
        prim.attributes["COLOR_0"] = col0Accessor;

        auto col1View = builder.addBufferView(
            col1.data(),
            col1.size() * sizeof(float),
            CesiumGltf::BufferView::Target::ARRAY_BUFFER);
        auto col1Accessor = builder.addAccessor(
            col1View,
            CesiumGltf::Accessor::ComponentType::FLOAT,
            posCount,
            CesiumGltf::Accessor::Type::VEC4);
        prim.attributes["COLOR_1"] = col1Accessor;
    };

    if (!lineData.positions.empty()) {
        auto& prim = mesh.primitives.emplace_back();
        prim.mode = CesiumGltf::MeshPrimitive::Mode::TRIANGLES;
        prim.material = 0;
        addPrimitiveCommon(
            prim,
            lineData.positions,
            lineData.normals,
            lineData.texCoord0,
            lineData.texCoord1,
            lineData.texCoord2,
            lineData.color0,
            lineData.color1);

        auto idxView = builder.addBufferView(
            lineData.indices.data(),
            lineData.indices.size() * sizeof(uint32_t),
            CesiumGltf::BufferView::Target::ELEMENT_ARRAY_BUFFER);
        auto idxAccessor = builder.addAccessor(
            idxView,
            CesiumGltf::Accessor::ComponentType::UNSIGNED_INT,
            static_cast<int64_t>(lineData.indices.size()),
            CesiumGltf::Accessor::Type::SCALAR);
        prim.indices = idxAccessor;
    }

    if (!lineCenterData.positions.empty()) {
        auto& prim = mesh.primitives.emplace_back();
        prim.mode = CesiumGltf::MeshPrimitive::Mode::LINES;
        prim.material = 0;
        addPrimitiveCommon(
            prim,
            lineCenterData.positions,
            lineCenterData.normals,
            lineCenterData.texCoord0,
            lineCenterData.texCoord1,
            lineCenterData.texCoord2,
            lineCenterData.color0,
            lineCenterData.color1);

        auto idxView = builder.addBufferView(
            lineCenterData.indices.data(),
            lineCenterData.indices.size() * sizeof(uint32_t),
            CesiumGltf::BufferView::Target::ELEMENT_ARRAY_BUFFER);
        auto idxAccessor = builder.addAccessor(
            idxView,
            CesiumGltf::Accessor::ComponentType::UNSIGNED_INT,
            static_cast<int64_t>(lineCenterData.indices.size()),
            CesiumGltf::Accessor::Type::SCALAR);
        prim.indices = idxAccessor;
    }

    if (!triData.positions.empty()) {
        auto& prim = mesh.primitives.emplace_back();
        prim.mode = CesiumGltf::MeshPrimitive::Mode::TRIANGLES;
        prim.material = 0;
        addPrimitiveCommon(
            prim,
            triData.positions,
            triData.normals,
            triData.texCoord0,
            triData.texCoord1,
            triData.texCoord2,
            triData.color0,
            triData.color1);
    }

    if (!pointData.positions.empty()) {
        auto& prim = mesh.primitives.emplace_back();
        prim.mode = CesiumGltf::MeshPrimitive::Mode::POINTS;
        prim.material = 0;
        addPrimitiveCommon(
            prim,
            pointData.positions,
            pointData.normals,
            pointData.texCoord0,
            pointData.texCoord1,
            pointData.texCoord2,
            pointData.color0,
            pointData.color1);
    }

    model.buffers.back().byteLength = static_cast<int64_t>(buffer.size());

    CesiumGltfWriter::GltfWriter gltfWriter;
    auto glbResult = gltfWriter.writeGlb(model, gsl::span<const std::byte>(buffer.data(), buffer.size()));
    if (!glbResult.errors.empty()) {
        std::cout << "Failed to write glTF: " << glbResult.errors[0] << std::endl;
        return false;
    }

    result.writeToArray(glbResult.gltfBytes);
    return true;
}

void FeatureLayerVisualization3DTiles::makeTileset(
    std::string const& tileGlbUrl,
    SharedUint8Array& result) const
{
    nlohmann::json tileset;
    tileset["asset"] = {
        {"version", "1.1"},
        {"gltfUpAxis", "Z"}
    };
    tileset["geometricError"] = 1.0;

    std::vector<double> transform(
        glm::value_ptr(enuToEcef_), glm::value_ptr(enuToEcef_) + 16);

    nlohmann::json root;
    root["transform"] = transform;
    root["refine"] = "REPLACE";
    root["geometricError"] = 0.0;
    root["boundingVolume"] = {
        {"sphere", {0.0, 0.0, 0.0, std::max(1.0, boundingRadius_)}}
    };
    root["content"] = {
        {"uri", tileGlbUrl}
    };
    tileset["root"] = root;

    result.writeToArray(tileset.dump());
}

} // namespace erdblick
