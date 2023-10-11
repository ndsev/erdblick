#include "color.h"

namespace erdblick
{

Color::Color() : glm::u8vec3(0, 0, 0) {}

Color::Color(const Color& other)
    : glm::u8vec3(other)
      , valid_(other.valid_)
{}

Color::Color(const char* hexString)
    : Color(std::string{hexString})
{}

Color::Color(const std::string& hexString)
{
    std::string_view str(hexString);

    if (str.find("0x") == 0)
        str.remove_prefix(2);
    else if (str.find("#") == 0)
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

Color const Color::AliceBlue("#F0F8FF");
Color const Color::AntiqueWhite("#FAEBD7");
Color const Color::Aqua("#00FFFF");
Color const Color::Aquamarine("#7FFFD4");
Color const Color::Azure("#F0FFFF");
Color const Color::Beige("#F5F5DC");
Color const Color::Bisque("#FFE4C4");
Color const Color::Black("#000000");
Color const Color::BlanchedAlmond("#FFEBCD");
Color const Color::Blue("#0000FF");
Color const Color::BlueViolet("#8A2BE2");
Color const Color::Brown("#A52A2A");
Color const Color::BurlyWood("#DEB887");
Color const Color::CadetBlue("#5F9EA0");
Color const Color::Chartreuse("#7FFF00");
Color const Color::Chocolate("#D2691E");
Color const Color::Coral("#FF7F50");
Color const Color::CornflowerBlue("#6495ED");
Color const Color::Cornsilk("#FFF8DC");
Color const Color::Crimson("#DC143C");
Color const Color::Cyan("#00FFFF");
Color const Color::DarkBlue("#00008B");
Color const Color::DarkCyan("#008B8B");
Color const Color::DarkGoldenRod("#B8860B");
Color const Color::DarkGray("#A9A9A9");
Color const Color::DarkGrey("#A9A9A9");
Color const Color::DarkGreen("#006400");
Color const Color::DarkKhaki("#BDB76B");
Color const Color::DarkMagenta("#8B008B");
Color const Color::DarkOliveGreen("#556B2F");
Color const Color::DarkOrange("#FF8C00");
Color const Color::DarkOrchid("#9932CC");
Color const Color::DarkRed("#8B0000");
Color const Color::DarkSalmon("#E9967A");
Color const Color::DarkSeaGreen("#8FBC8F");
Color const Color::DarkSlateBlue("#483D8B");
Color const Color::DarkSlateGray("#2F4F4F");
Color const Color::DarkSlateGrey("#2F4F4F");
Color const Color::DarkTurquoise("#00CED1");
Color const Color::DarkViolet("#9400D3");
Color const Color::DeepPink("#FF1493");
Color const Color::DeepSkyBlue("#00BFFF");
Color const Color::DimGray("#696969");
Color const Color::DimGrey("#696969");
Color const Color::DodgerBlue("#1E90FF");
Color const Color::FireBrick("#B22222");
Color const Color::FloralWhite("#FFFAF0");
Color const Color::ForestGreen("#228B22");
Color const Color::Fuchsia("#FF00FF");
Color const Color::Gainsboro("#DCDCDC");
Color const Color::GhostWhite("#F8F8FF");
Color const Color::Gold("#FFD700");
Color const Color::GoldenRod("#DAA520");
Color const Color::Gray("#808080");
Color const Color::Grey("#808080");
Color const Color::Green("#008000");
Color const Color::GreenYellow("#ADFF2F");
Color const Color::HoneyDew("#F0FFF0");
Color const Color::HotPink("#FF69B4");
Color const Color::IndianRed("#CD5C5C");
Color const Color::Indigo("#4B0082");
Color const Color::Ivory("#FFFFF0");
Color const Color::Khaki("#F0E68C");
Color const Color::Lavender("#E6E6FA");
Color const Color::LavenderBlush("#FFF0F5");
Color const Color::LawnGreen("#7CFC00");
Color const Color::LemonChiffon("#FFFACD");
Color const Color::LightBlue("#ADD8E6");
Color const Color::LightCoral("#F08080");
Color const Color::LightCyan("#E0FFFF");
Color const Color::LightGoldenRodYellow("#FAFAD2");
Color const Color::LightGray("#D3D3D3");
Color const Color::LightGrey("#D3D3D3");
Color const Color::LightGreen("#90EE90");
Color const Color::LightPink("#FFB6C1");
Color const Color::LightSalmon("#FFA07A");
Color const Color::LightSeaGreen("#20B2AA");
Color const Color::LightSkyBlue("#87CEFA");
Color const Color::LightSlateGray("#778899");
Color const Color::LightSlateGrey("#778899");
Color const Color::LightSteelBlue("#B0C4DE");
Color const Color::LightYellow("#FFFFE0");
Color const Color::Lime("#00FF00");
Color const Color::LimeGreen("#32CD32");
Color const Color::Linen("#FAF0E6");
Color const Color::Magenta("#FF00FF");
Color const Color::Maroon("#800000");
Color const Color::MediumAquaMarine("#66CDAA");
Color const Color::MediumBlue("#0000CD");
Color const Color::MediumOrchid("#BA55D3");
Color const Color::MediumPurple("#9370DB");
Color const Color::MediumSeaGreen("#3CB371");
Color const Color::MediumSlateBlue("#7B68EE");
Color const Color::MediumSpringGreen("#00FA9A");
Color const Color::MediumTurquoise("#48D1CC");
Color const Color::MediumVioletRed("#C71585");
Color const Color::MidnightBlue("#191970");
Color const Color::MintCream("#F5FFFA");
Color const Color::MistyRose("#FFE4E1");
Color const Color::Moccasin("#FFE4B5");
Color const Color::NavajoWhite("#FFDEAD");
Color const Color::Navy("#000080");
Color const Color::OldLace("#FDF5E6");
Color const Color::Olive("#808000");
Color const Color::OliveDrab("#6B8E23");
Color const Color::Orange("#FFA500");
Color const Color::OrangeRed("#FF4500");
Color const Color::Orchid("#DA70D6");
Color const Color::PaleGoldenRod("#EEE8AA");
Color const Color::PaleGreen("#98FB98");
Color const Color::PaleTurquoise("#AFEEEE");
Color const Color::PaleVioletRed("#DB7093");
Color const Color::PapayaWhip("#FFEFD5");
Color const Color::PeachPuff("#FFDAB9");
Color const Color::Peru("#CD853F");
Color const Color::Pink("#FFC0CB");
Color const Color::Plum("#DDA0DD");
Color const Color::PowderBlue("#B0E0E6");
Color const Color::Purple("#800080");
Color const Color::RebeccaPurple("#663399");
Color const Color::Red("#FF0000");
Color const Color::RosyBrown("#BC8F8F");
Color const Color::RoyalBlue("#4169E1");
Color const Color::SaddleBrown("#8B4513");
Color const Color::Salmon("#FA8072");
Color const Color::SandyBrown("#F4A460");
Color const Color::SeaGreen("#2E8B57");
Color const Color::SeaShell("#FFF5EE");
Color const Color::Sienna("#A0522D");
Color const Color::Silver("#C0C0C0");
Color const Color::SkyBlue("#87CEEB");
Color const Color::SlateBlue("#6A5ACD");
Color const Color::SlateGray("#708090");
Color const Color::SlateGrey("#708090");
Color const Color::Snow("#FFFAFA");
Color const Color::SpringGreen("#00FF7F");
Color const Color::SteelBlue("#4682B4");
Color const Color::Tan("#D2B48C");
Color const Color::Teal("#008080");
Color const Color::Thistle("#D8BFD8");
Color const Color::Tomato("#FF6347");
Color const Color::Turquoise("#40E0D0");
Color const Color::Violet("#EE82EE");
Color const Color::Wheat("#F5DEB3");
Color const Color::White("#FFFFFF");
Color const Color::WhiteSmoke("#F5F5F5");
Color const Color::Yellow("#FFFF00");
Color const Color::YellowGreen("#9ACD32");

}