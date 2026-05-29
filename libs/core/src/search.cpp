#include "search.h"

#include "fmt/format.h"

std::string erdblick::anyWrap(const std::string_view& q)
{
    return fmt::format("any({})", q);
}
