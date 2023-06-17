#include "SharedUint8Array.h"
#include <iostream>
#include <sstream>

SharedUint8Array::SharedUint8Array(uint32_t size) : size_(size)
{
    array_.resize(size_);
}

uint32_t SharedUint8Array::getSize() const
{
    return size_;
}

__UINT64_TYPE__ SharedUint8Array::getPointer()
{
    return reinterpret_cast<__UINT64_TYPE__>(array_.data());
}

void SharedUint8Array::writeToArray(const char* start, const char* end)
{
    array_.assign(start, end);
}

std::string SharedUint8Array::toString() {
    return {array_.begin(), array_.end()};
}
