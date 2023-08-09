#include "buffer.h"

namespace erdblick
{

SharedUint8Array::SharedUint8Array(uint32_t size)
{
    array_.resize(size);
}

uint32_t SharedUint8Array::getSize() const
{
    return array_.size();
}

SharedUint8Array::SharedUint8Array(const std::string& data)
{
    array_.assign(data.begin(), data.end());
}

__UINT64_TYPE__ SharedUint8Array::getPointer()
{
    return reinterpret_cast<__UINT64_TYPE__>(array_.data());
}

void SharedUint8Array::writeToArray(const char* start, const char* end)
{
    array_.assign(start, end);
}

void SharedUint8Array::writeToArray(std::string const& content)
{
    array_.assign(content.begin(), content.end());
}

std::string SharedUint8Array::toString() const
{
    return {array_.begin(), array_.end()};
}

void SharedUint8Array::writeToArray(const std::vector<std::byte>& content)
{
    array_.resize(content.size());
    std::memcpy(array_.data(), content.data(), content.size());
}

}