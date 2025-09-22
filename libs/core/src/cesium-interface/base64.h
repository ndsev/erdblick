#pragma once

#include <cstdint>
#include <span>
#include <vector>
#include <string>

#include "yaml-cpp/binary.h"

namespace erdblick::base64
{

/**
 * Encode a vector to a base64 string.
 *
 * @param data  Vector to encode
 */
inline std::string encode(const std::span<std::uint8_t>& data)
{
    return YAML::EncodeBase64(data.data(), data.size());
}

/**
 * Decode a base64 encoded vector to an uint8 vector.
 *
 * @param data  Base64 string to decode.
 */
inline std::vector<std::uint8_t> decode(const std::string& data)
{
    return YAML::DecodeBase64(data);
}

}
