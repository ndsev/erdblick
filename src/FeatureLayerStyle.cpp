#include "include/FeatureLayerStyle.h"
#include "yaml-cpp/node/node.h"
#include "yaml-cpp/node/parse.h"

FeatureLayerStyle::FeatureLayerStyle(__UINT64_TYPE__ yamlBufferPtr, uint32_t bufferSize) {
    // Load the chars from provided buffer into a vector.
    auto yamlStyleSpec = std::vector<char>(yamlBufferPtr, yamlBufferPtr + bufferSize);

    // Convert char vector to YAML node.
    auto yamlNode = YAML::Load(&yamlStyleSpec);

    // Parse all style fields from YAML node.
    
}
