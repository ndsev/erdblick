#ifndef ERDBLICK_SHAREDUINT8ARRAY_H
#define ERDBLICK_SHAREDUINT8ARRAY_H

#include <vector>
#include <emscripten/bind.h>

class SharedUint8Array
{
public:
    SharedUint8Array(uint32_t size);
    uint32_t getSize() const;
    __UINT64_TYPE__ getPointer();
    void writeToArray(const char* start, const char* end);
    std::string toString();

private:
    uint32_t size_;
    std::vector<uint8_t> array_;
};

#endif  // ERDBLICK_SHAREDUINT8ARRAY_H
