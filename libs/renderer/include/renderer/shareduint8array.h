#ifndef ERDBLICK_SHAREDUINT8ARRAY_H
#define ERDBLICK_SHAREDUINT8ARRAY_H

#include <vector>
#include <emscripten/bind.h>

class SharedUint8Array
{
public:
    SharedUint8Array() = default;
    explicit SharedUint8Array(uint32_t size);
    [[nodiscard]] uint32_t getSize() const;
    __UINT64_TYPE__ getPointer();
    std::shared_ptr<std::vector<uint8_t>> getArray();

    void writeToArray(const char* start, const char* end);
    void writeToArray(std::string& content);

    std::string toString();
private:
    std::vector<uint8_t> array_;
};

#endif  // ERDBLICK_SHAREDUINT8ARRAY_H
