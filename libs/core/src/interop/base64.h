#pragma once

#include <cstdint>
#include <span>
#include <vector>
#include <string>

#include "yaml-cpp/binary.h"

namespace erdblick::base64
{

/**
 * Encode a byte span to a base64 string.
 *
 * @param data  Bytes to encode
 */
inline std::string encode(std::span<const std::uint8_t> data)
{
    return YAML::EncodeBase64(data.data(), data.size());
}

/**
 * Decode a base64 string into a byte vector.
 *
 * @param data  Base64 string to decode.
 */
inline std::vector<std::uint8_t> decode(const std::string& data)
{
    return YAML::DecodeBase64(data);
}

}
