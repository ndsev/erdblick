#include <vector>
#include <iostream>
#include <sstream>

#include "duckfile.c"
#include "tiny_gltf.h"

#include "featurelayerrenderer.h"

FeatureLayerRenderer::FeatureLayerRenderer() = default;

void FeatureLayerRenderer::render(
    const FeatureLayerStyle& style,
    const std::shared_ptr<mapget::TileFeatureLayer>& layer,
    SharedUint8Array& data)
{
    for (auto& rule : style.rules()) {
        for (auto&& feature : *layer) {
            if (rule.match(*feature)) {
                // TODO visualization.
            }
        }
    }

    // Just a tinygltf sample as a starter.
    std::vector<double> coords = {0.0, 0.0, 0.0, 1.0, 1.0, 1.0};

    tinygltf::Model model;
    model.asset.version = "2.0";
    model.asset.generator = "TinyGLTF";

    tinygltf::Scene scene;
    scene.nodes.push_back(0);
    model.scenes.push_back(scene);

    tinygltf::Node node;
    node.mesh = 0;
    model.nodes.push_back(node);

    tinygltf::Mesh mesh;
    tinygltf::Primitive primitive;
    primitive.mode = TINYGLTF_MODE_LINE;
    primitive.attributes["POSITION"] = 1; // Index of the POSITION accessor
    mesh.primitives.push_back(primitive);
    model.meshes.push_back(mesh);

    tinygltf::Accessor accessor;
    accessor.bufferView = 0;
    accessor.byteOffset = 0;
    accessor.componentType = TINYGLTF_COMPONENT_TYPE_FLOAT;
    accessor.count = static_cast<int>(coords.size() / 3);
    accessor.type = TINYGLTF_TYPE_VEC3;
    accessor.maxValues = {1.0, 1.0, 1.0}; // Maximum coordinate values
    accessor.minValues = {0.0, 0.0, 0.0}; // Minimum coordinate values
    model.accessors.push_back(accessor);

    tinygltf::BufferView bufferView;
    bufferView.buffer = 0;
    bufferView.byteOffset = 0;
    bufferView.byteLength = static_cast<int>(coords.size() * sizeof(double));
    bufferView.target = TINYGLTF_TARGET_ARRAY_BUFFER;
    model.bufferViews.push_back(bufferView);

    tinygltf::Buffer buffer;
    buffer.data.resize(static_cast<size_t>(bufferView.byteLength));
    std::memcpy(buffer.data.data(), coords.data(), static_cast<size_t>(bufferView.byteLength));
    model.buffers.push_back(buffer);

    tinygltf::TinyGLTF gltfSerializer;

    // Write the glTF model to an output stream.
    std::ostringstream stream;
    bool success = gltfSerializer.WriteGltfSceneToStream(&model, stream, true, true);
    if (!success) {
        std::cerr << "Failed to write glTF to output stream." << std::endl;
    }

    // Get the string representation of the stream.
    std::string glbStr = stream.str();
    data.writeToArray(glbStr);
    // data.writeToArray(std::begin(duckfile), std::end(duckfile));
}

