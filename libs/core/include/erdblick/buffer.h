#pragma once

#include <vector>
#include <stdint.h>
#include <memory>
#include <string>

namespace erdblick
{

/**
 * Small owning byte buffer used as the C++/WASM boundary type for binary payloads.
 *
 * The class deliberately exposes only coarse operations so callers can pass tile
 * blobs, YAML documents, and stream chunks around without caring whether the
 * backing storage originated in JS, native code, or test fixtures.
 */
class SharedUint8Array
{
public:
    /** Construct an empty buffer. */
    SharedUint8Array() = default;

    /** Allocate a zero-initialized buffer of the requested byte size. */
    explicit SharedUint8Array(uint32_t size);

    /** Copy a string payload into the buffer verbatim. */
    explicit SharedUint8Array(std::string const& data);

    /** Return the current buffer size in bytes. */
    [[nodiscard]] uint32_t getSize() const;

    /**
     * Borrow the address of the current bytes for a WASM heap view.
     * A write may reallocate storage; destruction invalidates the address.
     * JavaScript must also recreate its heap view after WASM memory grows.
     */
    uintptr_t getPointer();

    /** Replace the buffer contents with the bytes in the half-open range `[start, end)`. */
    void writeToArray(const char* start, const char* end);

    /** Replace the buffer contents with a string payload. */
    void writeToArray(std::string const& content);

    /** Replace the buffer contents with the given byte vector. */
    void writeToArray(std::vector<std::byte> const& content);

    /** Interpret the current bytes as a string without applying any transcoding. */
    std::string toString() const;

    /**
     * Provide direct read access to the underlying byte storage. The vector is
     * borrowed; its contents and element addresses can change on the next write.
     */
    std::vector<uint8_t> const& bytes() const;

private:
    std::vector<uint8_t> array_;
};

}
