#include "SharedUint8Array.h"

SharedUint8Array::SharedUint8Array(uint32_t size) : size_(size)
{
    array_.resize(size);
}

uint32_t SharedUint8Array::getSize() const
{
    return size_;
}

__UINT64_TYPE__ SharedUint8Array::getPointer()
{
    return reinterpret_cast<__UINT64_TYPE__>(array_.data());
}

void SharedUint8Array::writeToArray(char const* start, char const* end)
{
    array_.assign(start, end);
}
