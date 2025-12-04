#include "color.h"

namespace erdblick
{

Color::Color() : glm::u8vec3(0, 0, 0) {}

Color::Color(const Color& other)
    : glm::u8vec3(other)
      , valid_(other.valid_)
{}

Color::Color(const char* colorString)
    : Color(std::string{colorString})
{}

Color::Color(const std::string& colorString) : vec()
{
    // Match the string to a CSS color name, e.g. 'red'
    auto cssColorIt = cssColors.find(colorString);
    if (cssColorIt != cssColors.end()) {
        *this = cssColorIt->second;
        return;
    }

    // Parse the string as a hex-color
    std::string_view str(colorString);

    if (str.find("0x") == 0)
        str.remove_prefix(2);
    else if (str.find('#') == 0)
        str.remove_prefix(1);

    auto parseHexDigit = [](std::string_view& v, std::size_t digits) {
        digits = std::min<std::size_t>(2, digits);

        char chr[3] = {0};
        v.copy(chr, digits);
        v.remove_prefix(digits);

        return static_cast<uint8_t>(std::strtoll(chr, nullptr, 16));
    };

    valid_ = true;
    switch (str.size()) {
    case 6:
        r = parseHexDigit(str, 2);
        g = parseHexDigit(str, 2);
        b = parseHexDigit(str, 2);
        break;

    case 3:
        r = parseHexDigit(str, 1) * 16;
        g = parseHexDigit(str, 1) * 16;
        b = parseHexDigit(str, 1) * 16;
        break;

    default:
        valid_ = false;
    }
}

Color::Color(uint8_t r, uint8_t g, uint8_t b) : glm::u8vec3(r, g, b) {
    valid_ = true;
}

namespace {

uint8_t mapToIntColorSpace(float val){
    return static_cast<uint8_t>(std::max(0.f, std::min(val, 1.f)) * 255);
}

}

Color::Color(float r, float g, float b):
      glm::u8vec3(
          mapToIntColorSpace(r),
          mapToIntColorSpace(g),
          mapToIntColorSpace(b)),
      valid_(true)
{ }

Color Color::fromHSV(const glm::vec3& hsv) {
    /* Source: https://stackoverflow.com/a/6930407 */
    double hh, p, q, t, ff;
    long i;
    glm::vec3 out;

    if (hsv.y <= 0.0) {
        out.x = hsv.z;
        out.y = hsv.z;
        out.z = hsv.z;

        return Color::fromRGB(out);
    }

    hh = hsv.x;
    if (hh >= 360.0)
        hh = 0.0;
    hh /= 60.0;

    i = (long)hh;
    ff = hh - i;
    p = hsv.z * (1.0 - hsv.y);
    q = hsv.z * (1.0 - (hsv.y * ff));
    t = hsv.z * (1.0 - (hsv.y * (1.0 - ff)));

    switch(i) {
    case 0:
        out.x = hsv.z;
        out.y = t;
        out.z = p;
        break;
    case 1:
        out.x = q;
        out.y = hsv.z;
        out.z = p;
        break;
    case 2:
        out.x = p;
        out.y = hsv.z;
        out.z = t;
        break;

    case 3:
        out.x = p;
        out.y = q;
        out.z = hsv.z;
        break;
    case 4:
        out.x = t;
        out.y = p;
        out.z = hsv.z;
        break;
    case 5:
    default:
        out.x = hsv.z;
        out.y = p;
        out.z = q;
        break;
    }

    return Color::fromRGB(out);
}

Color Color::fromRGB(const glm::vec3& rgb)
{
    return {rgb.x, rgb.y, rgb.z};
}

Color Color::fromRGB(uint32_t rrggbb)
{
    return Color(static_cast<uint8_t>((rrggbb >> 16) & 0xff),
                    static_cast<uint8_t>((rrggbb >> 8)  & 0xff),
                    static_cast<uint8_t>((rrggbb)       & 0xff));
}


std::string Color::toString() const {
    char buf[8] = {0};
    std::size_t size = snprintf(buf, sizeof(buf), "#%02x%02x%02x",
                                (int)r, (int)g, (int)b);

    return {buf, size};
}

std::string Color::toString(float opacity) const {
    char buf[10] = {0};
    std::size_t size = snprintf(buf, sizeof(buf), "#%02x%02x%02x%02x",
                                (int)r, (int)g, (int)b, (int)mapToIntColorSpace(opacity));

    return {buf, size};
}

glm::vec4 Color::toFVec4(float opacity) const {
    return {
        static_cast<float>(r)/255.,
        static_cast<float>(g)/255.,
        static_cast<float>(b)/255.,
        std::max(0.f, std::min(1.f, opacity))
    };
}

glm::vec3 Color::toHSV() const {
    /* Source: https://stackoverflow.com/a/6930407 */
    glm::vec3 hsv;
    glm::vec4 in = toFVec4();

    auto min = std::min<double>(std::min<double>(in.x, in.y), in.z);
    auto max = std::max<double>(std::max<double>(in.x, in.y), in.z);

    hsv.z = max; // v
    auto delta = max - min;
    if (delta < 0.00001) {
        hsv.y = 0;
        hsv.x = 0;
        return hsv;
    }

    if (max > 0.0) {
        hsv.y = (delta / max); // s
    } else {
        // if max is 0, then r = g = b = 0
        // s = 0, h is undefined
        hsv.y = 0.0;
        hsv.x = NAN; // its now undefined
        return hsv;
    }

    if (in.x >= max)
        hsv.x = (in.y - in.z) / delta;        // between yellow & magenta
    else if (in.y >= max)
        hsv.x = 2.0 + (in.z - in.x) / delta;  // between cyan & yellow
    else
        hsv.x = 4.0 + (in.x - in.y) / delta;  // between magenta & cyan

    hsv.x *= 60.0; // degrees

    if (hsv.x < 0.0)
        hsv.x += 360.0;

    return hsv;
}

uint32_t Color::toABGR(uint8_t opacity) const {
    return
        (static_cast<uint32_t>(opacity) << 24u) |
        (static_cast<uint32_t>(b) << 16u) |
        (static_cast<uint32_t>(g) << 8u) | r;
}

uint32_t Color::toRGBA(uint8_t opacity) const {
    return
        (static_cast<uint32_t>(r) << 24u) |
        (static_cast<uint32_t>(g) << 16u) |
        (static_cast<uint32_t>(b) << 8u) | opacity;
}

uint32_t Color::toARGB(uint8_t opacity) const {
    return
        (static_cast<uint32_t>(opacity) << 24u) |
        (static_cast<uint32_t>(r) << 16u) |
        (static_cast<uint32_t>(g) << 8u) | b;
}

Color& Color::operator= (Color const& other) noexcept {
    r = other.r;
    g = other.g;
    b = other.b;
    valid_ = other.valid_;
    return *this;
}

bool Color::isValid() const {
    return valid_ || r != 0 || g != 0 || b != 0;
}

JsValue Color::toCesiumColor(float opacity) const
{
    return Cesium().Color.New((float)r/255., (float)g/255., (float)b/255., opacity);
}

const std::map<std::string, Color> Color::cssColors = {
    {"aliceblue", Color("#F0F8FF")},
    {"antiquewhite", Color("#FAEBD7")},
    {"aqua", Color("#00FFFF")},
    {"aquamarine", Color("#7FFFD4")},
    {"azure", Color("#F0FFFF")},
    {"beige", Color("#F5F5DC")},
    {"bisque", Color("#FFE4C4")},
    {"black", Color("#000000")},
    {"blanchedalmond", Color("#FFEBCD")},
    {"blue", Color("#0000FF")},
    {"blueviolet", Color("#8A2BE2")},
    {"brown", Color("#A52A2A")},
    {"burlywood", Color("#DEB887")},
    {"cadetblue", Color("#5F9EA0")},
    {"chartreuse", Color("#7FFF00")},
    {"chocolate", Color("#D2691E")},
    {"coral", Color("#FF7F50")},
    {"cornflowerblue", Color("#6495ED")},
    {"cornsilk", Color("#FFF8DC")},
    {"crimson", Color("#DC143C")},
    {"cyan", Color("#00FFFF")},
    {"darkblue", Color("#00008B")},
    {"darkcyan", Color("#008B8B")},
    {"darkgoldenrod", Color("#B8860B")},
    {"darkgray", Color("#A9A9A9")},
    {"darkgrey", Color("#A9A9A9")},
    {"darkgreen", Color("#006400")},
    {"darkkhaki", Color("#BDB76B")},
    {"darkmagenta", Color("#8B008B")},
    {"darkolivegreen", Color("#556B2F")},
    {"darkorange", Color("#FF8C00")},
    {"darkorchid", Color("#9932CC")},
    {"darkred", Color("#8B0000")},
    {"darksalmon", Color("#E9967A")},
    {"darkseagreen", Color("#8FBC8F")},
    {"darkslateblue", Color("#483D8B")},
    {"darkslategray", Color("#2F4F4F")},
    {"darkslategrey", Color("#2F4F4F")},
    {"darkturquoise", Color("#00CED1")},
    {"darkviolet", Color("#9400D3")},
    {"deeppink", Color("#FF1493")},
    {"deepskyblue", Color("#00BFFF")},
    {"dimgray", Color("#696969")},
    {"dimgrey", Color("#696969")},
    {"dodgerblue", Color("#1E90FF")},
    {"firebrick", Color("#B22222")},
    {"floralwhite", Color("#FFFAF0")},
    {"forestgreen", Color("#228B22")},
    {"fuchsia", Color("#FF00FF")},
    {"gainsboro", Color("#DCDCDC")},
    {"ghostwhite", Color("#F8F8FF")},
    {"gold", Color("#FFD700")},
    {"goldenrod", Color("#DAA520")},
    {"gray", Color("#808080")},
    {"grey", Color("#808080")},
    {"green", Color("#008000")},
    {"greenyellow", Color("#ADFF2F")},
    {"honeydew", Color("#F0FFF0")},
    {"hotpink", Color("#FF69B4")},
    {"indianred", Color("#CD5C5C")},
    {"indigo", Color("#4B0082")},
    {"ivory", Color("#FFFFF0")},
    {"khaki", Color("#F0E68C")},
    {"lavender", Color("#E6E6FA")},
    {"lavenderblush", Color("#FFF0F5")},
    {"lawngreen", Color("#7CFC00")},
    {"lemonchiffon", Color("#FFFACD")},
    {"lightblue", Color("#ADD8E6")},
    {"lightcoral", Color("#F08080")},
    {"lightcyan", Color("#E0FFFF")},
    {"lightgoldenrodyellow", Color("#FAFAD2")},
    {"lightgray", Color("#D3D3D3")},
    {"lightgrey", Color("#D3D3D3")},
    {"lightgreen", Color("#90EE90")},
    {"lightpink", Color("#FFB6C1")},
    {"lightsalmon", Color("#FFA07A")},
    {"lightseagreen", Color("#20B2AA")},
    {"lightskyblue", Color("#87CEFA")},
    {"lightslategray", Color("#778899")},
    {"lightslategrey", Color("#778899")},
    {"lightsteelblue", Color("#B0C4DE")},
    {"lightyellow", Color("#FFFFE0")},
    {"lime", Color("#00FF00")},
    {"limegreen", Color("#32CD32")},
    {"linen", Color("#FAF0E6")},
    {"magenta", Color("#FF00FF")},
    {"maroon", Color("#800000")},
    {"mediumaquamarine", Color("#66CDAA")},
    {"mediumblue", Color("#0000CD")},
    {"mediumorchid", Color("#BA55D3")},
    {"mediumpurple", Color("#9370DB")},
    {"mediumseagreen", Color("#3CB371")},
    {"mediumslateblue", Color("#7B68EE")},
    {"mediumspringgreen", Color("#00FA9A")},
    {"mediumturquoise", Color("#48D1CC")},
    {"mediumvioletred", Color("#C71585")},
    {"midnightblue", Color("#191970")},
    {"mintcream", Color("#F5FFFA")},
    {"mistyrose", Color("#FFE4E1")},
    {"moccasin", Color("#FFE4B5")},
    {"navajowhite", Color("#FFDEAD")},
    {"navy", Color("#000080")},
    {"oldlace", Color("#FDF5E6")},
    {"olive", Color("#808000")},
    {"olivedrab", Color("#6B8E23")},
    {"orange", Color("#FFA500")},
    {"orangered", Color("#FF4500")},
    {"orchid", Color("#DA70D6")},
    {"palegoldenrod", Color("#EEE8AA")},
    {"palegreen", Color("#98FB98")},
    {"paleturquoise", Color("#AFEEEE")},
    {"palevioletred", Color("#DB7093")},
    {"papayawhip", Color("#FFEFD5")},
    {"peachpuff", Color("#FFDAB9")},
    {"peru", Color("#CD853F")},
    {"pink", Color("#FFC0CB")},
    {"plum", Color("#DDA0DD")},
    {"powderblue", Color("#B0E0E6")},
    {"purple", Color("#800080")},
    {"rebeccapurple", Color("#663399")},
    {"red", Color("#FF0000")},
    {"rosybrown", Color("#BC8F8F")},
    {"royalblue", Color("#4169E1")},
    {"saddlebrown", Color("#8B4513")},
    {"salmon", Color("#FA8072")},
    {"sandybrown", Color("#F4A460")},
    {"seagreen", Color("#2E8B57")},
    {"seashell", Color("#FFF5EE")},
    {"sienna", Color("#A0522D")},
    {"silver", Color("#C0C0C0")},
    {"skyblue", Color("#87CEEB")},
    {"slateblue", Color("#6A5ACD")},
    {"slategray", Color("#708090")},
    {"slategrey", Color("#708090")},
    {"snow", Color("#FFFAFA")},
    {"springgreen", Color("#00FF7F")},
    {"steelblue", Color("#4682B4")},
    {"tan", Color("#D2B48C")},
    {"teal", Color("#008080")},
    {"thistle", Color("#D8BFD8")},
    {"tomato", Color("#FF6347")},
    {"turquoise", Color("#40E0D0")},
    {"violet", Color("#EE82EE")},
    {"wheat", Color("#F5DEB3")},
    {"white", Color("#FFFFFF")},
    {"whitesmoke", Color("#F5F5F5")},
    {"yellow", Color("#FFFF00")},
    {"yellowgreen", Color("#9ACD32")},
};

}