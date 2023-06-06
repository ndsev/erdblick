#include <string>
#include <iostream>

#include "include/FeatureLayerStyle.h"
#include "yaml-cpp/yaml.h"

FeatureLayerStyle::FeatureLayerStyle(SharedUint8Array& yamlArray) {
    auto yamlStyleSpec = yamlArray.toString();
    std::cout << yamlStyleSpec << std::endl;

    // Convert char vector to YAML node.
    auto yamlNode = YAML::Load(yamlStyleSpec);
    if (yamlNode["features"] && yamlNode["features"].IsSequence()) {
        for (YAML::detail::iterator_value feature : yamlNode["features"]) {
            std::cout << feature["geometry"][0] << std::endl;
        }
    }
    // TODO Parse all style fields from YAML node.
}
