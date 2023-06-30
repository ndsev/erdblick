#include <iostream>
#include <map>
#include <sstream>
#include <vector>

#include "duckfile.c"
#include "glm/glm.hpp"
#include "tiny_gltf.h"

#include "renderer.h"

using namespace mapget;

namespace erdblick
{

namespace
{
constexpr auto GLOBE_RADIUS = 6371.;

template <typename ResultVec = glm::vec3>
ResultVec
wgsToEuclidean(Point const& wgsPoint, glm::dvec3 const& wgsOffset = glm::dvec3{.0, .0, .0})
{
    const double phi = wgsPoint.x * M_PI / 180.;
    const double theta = wgsPoint.y * M_PI / 180.;

    // TODO: Divisor should be 1000., but we leave it at 500 for 3D theatrics.
    const double elevation = GLOBE_RADIUS + (wgsPoint.z + 10.)/500.;
    return {
        elevation * glm::cos(theta) * glm::sin(phi) - wgsOffset.x,
        elevation * glm::sin(theta) - wgsOffset.y,
        elevation * glm::cos(theta) * glm::cos(phi) - wgsOffset.z};
}

/** GLTF conversion for one geometry type of one rule. */
struct RuleGeometry
{
    std::vector<glm::vec3> vertices_;
    int gltfPrimitiveMode_ = 0;
    glm::dvec3 const& offset_;
    FeatureStyleRule const& rule_;
    GeomType geomType_;

    RuleGeometry(GeomType geomType, glm::dvec3 const& offset, FeatureStyleRule const& rule)
        : offset_(offset), rule_(rule), geomType_(geomType)
    {
        switch (geomType_) {
        case GeomType::Line: gltfPrimitiveMode_ = TINYGLTF_MODE_LINE; break;
        case GeomType::Points: gltfPrimitiveMode_ = TINYGLTF_MODE_POINTS; break;
        case GeomType::Mesh: gltfPrimitiveMode_ = TINYGLTF_MODE_TRIANGLES; break;
        default:
            // empty
            break;
        }
    }

    std::pair<glm::vec3, glm::vec3> getMinMax()
    {
        if (vertices_.empty()) {
            throw std::runtime_error("Empty vertices vector.");
        }

        glm::vec3 minVec = vertices_[0];
        glm::vec3 maxVec = vertices_[0];

        for (const auto& v : vertices_) {
            minVec.x = std::min(minVec.x, v.x);
            minVec.y = std::min(minVec.y, v.y);
            minVec.z = std::min(minVec.z, v.z);
            maxVec.x = std::max(maxVec.x, v.x);
            maxVec.y = std::max(maxVec.y, v.y);
            maxVec.z = std::max(maxVec.z, v.z);
        }

        return {minVec, maxVec};
    }

    void addToScene(tinygltf::Model& model)
    {
        if (vertices_.empty())
            return;

        int nodeIndex = static_cast<int>(model.nodes.size());
        int meshIndex = static_cast<int>(model.meshes.size());
        int posAttrAccessorIndex = static_cast<int>(model.accessors.size());
        int bufferViewIndex = static_cast<int>(model.bufferViews.size());
        int bufferIndex = static_cast<int>(model.buffers.size());

        auto& node = model.nodes.emplace_back();
        node.mesh = meshIndex;
        model.nodes[0].children.push_back(nodeIndex);

        auto& mesh = model.meshes.emplace_back();
        auto& primitive = mesh.primitives.emplace_back();
        primitive.mode = gltfPrimitiveMode_;
        primitive.attributes["POSITION"] = posAttrAccessorIndex;

        auto& accessor = model.accessors.emplace_back();
        accessor.bufferView = bufferViewIndex;
        accessor.byteOffset = 0;
        accessor.componentType = TINYGLTF_COMPONENT_TYPE_FLOAT;
        accessor.count = static_cast<int>(vertices_.size());
        accessor.type = TINYGLTF_TYPE_VEC3;
        auto [minVal, maxVal] = getMinMax();
        accessor.minValues = {minVal.x, minVal.y, minVal.z};
        accessor.maxValues = {maxVal.x, maxVal.y, maxVal.z};

        auto& bufferView = model.bufferViews.emplace_back();
        bufferView.buffer = bufferIndex;
        bufferView.byteOffset = 0;
        bufferView.byteLength = static_cast<int>(vertices_.size() * 3 * sizeof(float_t));
        bufferView.target = TINYGLTF_TARGET_ARRAY_BUFFER;

        auto& buffer = model.buffers.emplace_back();
        buffer.data.resize(static_cast<size_t>(bufferView.byteLength));
        std::memcpy(
            buffer.data.data(),
            vertices_.data(),
            static_cast<size_t>(bufferView.byteLength));
    }

    void addFeature(model_ptr<Feature>& feature)
    {
        feature->geom()->forEachGeometry(
            [this](auto&& geom)
            {
                addGeometry(geom);
                return true;
            });
    }

    void addGeometry(model_ptr<Geometry> const& geom)
    {
        if (geom->geomType() != geomType_)
            return;
        // TODO: Add Geometry::numVertices
        // vertices_.reserve(vertices_.size() + geom->numVertices())
        uint32_t count = 0;
        geom->forEachPoint(
            [this, &count](auto&& vertex)
            {
                if (count > 1)
                    vertices_.emplace_back(vertices_.back());
                vertices_.emplace_back(wgsToEuclidean(vertex, offset_));
                ++count;
                return true;
            });
    }
};

}  // namespace

FeatureLayerRenderer::FeatureLayerRenderer() = default;

void FeatureLayerRenderer::render(  // NOLINT (render can be made static)
    const FeatureLayerStyle& style,
    const std::shared_ptr<TileFeatureLayer>& layer,
    SharedUint8Array& data)
{
    auto wgsOffset = wgsToEuclidean<glm::dvec3>(layer->tileId().center());
    std::map<std::pair<uint64_t, GeomType>, std::unique_ptr<RuleGeometry>> geomForRule;

    for (auto&& feature : *layer) {
        // TODO: Optimize performance by implementing style.rules(feature-type)
        for (auto&& rule : style.rules()) {
            if (rule.match(*feature)) {
                for (auto geomType : rule.geometryTypes()) {
                    auto [it, wasInserted] = geomForRule.emplace(
                        std::make_pair(reinterpret_cast<uint64_t>(&rule), geomType),
                        std::unique_ptr<RuleGeometry>{});
                    if (wasInserted) {
                        it->second = std::make_unique<RuleGeometry>(geomType, wgsOffset, rule);
                    }
                    it->second->addFeature(feature);
                }
            }
        }
    }

    // Convert to GLTF
    tinygltf::Model model;
    model.asset.version = "2.0";
    model.asset.generator = "TinyGLTF";
    auto& rootNode = model.nodes.emplace_back();
    rootNode.name = "root";
    rootNode.translation = {wgsOffset.x, wgsOffset.y, wgsOffset.z};
    auto& scene = model.scenes.emplace_back();
    scene.nodes.push_back(0); // Root node index is always 0
    for (auto&& [_, ruleGeom] : geomForRule) {
        ruleGeom->addToScene(model);
    }

    // Write the glTF model to an output stream.
    tinygltf::TinyGLTF gltfSerializer;
    std::ostringstream stream;
    bool success = gltfSerializer.WriteGltfSceneToStream(&model, stream, true, true);
    if (!success) {
        std::cerr << "Failed to write glTF to output stream." << std::endl;
    }

    // Get the string representation of the stream.
    std::string glbStr = stream.str();
    data.writeToArray(glbStr);
}

}  // namespace erdblick
