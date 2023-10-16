#pragma once

#include <glm/glm.hpp>
#include <stdint.h>
#include <string>
#include "cesium-interface/cesium.h"

namespace erdblick
{

/**
 * Color Class
 */
class Color : public glm::u8vec3
{
public:

    /**
      * Default constructor - will result in an invalid color.
     */
    Color();

    /**
      * Copy constructor
     */
    Color(const Color&);

    /**
      * Construct a color from a hex string. The string may have the following formats:
      * - #ffffff
      * - #fff
      * - 0xfffff
      * - 0xfff
      * If none of these formats matches the input, the resulting color will be invalid.
     */
    Color(const char* hexValue);
    Color(const std::string& hexValue);

    /**
      * Construct a color from 8 bit color components
     */
    Color(uint8_t r, uint8_t g, uint8_t b);

    /**
      * Construct a color from [0.,1.] floating point components.
      * Note: Values will be clamped to this range.
     */
    Color(float r, float g, float b);

    /**
      * Constructs a RGB color from an HSV color.
      * HSV value ranges [0deg, 360deg][0, 1][0, 1]
     */
    static Color fromHSV(const glm::vec3& hsv);

    /**
      * Constructs a RBG color from an RGB float vector ([0,1]).
     */
    static Color fromRGB(const glm::vec3& rgb);

    /**
      * Constructs a RBG color from an RGB uint; 8-bit per channel.
     */
    static Color fromRGB(uint32_t rrggbb);

    /**
      * Converts the value of this color to "#ffffff" hexstring format.
     */
    std::string toString() const;

    /**
      * Converts the value of this color to "#rrggbbaa" hexstring format.
      * Note: Opacity will be clamped to [0.,1.] range.
     */
    std::string toString(float opacity) const;

    /**
      * Converts the color to [0.,1.]*4 RGBA domain with the opacity parameter as the 4th value
      * Note: Opacity will be clamped to [0.,1.] range.
     */
    glm::vec4 toFVec4(float opacity=1.) const;

    /**
      * Converts the color to [0deg, 360deg][0, 1][0, 1] HSV vector.
     */
    glm::vec3 toHSV() const;

    /**
      * Converts the color to 32b ABGR.
     */
    uint32_t toABGR(uint8_t opacity) const;

    /**
      * Converts the color to 32b RGBA.
     */
    uint32_t toRGBA(uint8_t opacity) const;

    /**
      * Converts the color to 32b ARGB.
     */
    uint32_t toARGB(uint8_t opacity) const;

    /**
      * Assignment operator
     */
    Color& operator= (Color const& other) noexcept;

    /**
      * Returns false if the color was constructed from the default ctor,
      * or from an invalid hexstring, and all components are zero.
      * Use Color::Black to obtain a valid black color instance.
     */
    bool isValid() const;

    /**
     * Convert the color to a CesiumJS.Color object.
     */
    [[nodiscard]] JsValue toCesiumColor(float opacity) const;

    /**
      * Predefined color constants
     */
    static Color const AliceBlue;
    static Color const AntiqueWhite;
    static Color const Aqua;
    static Color const Aquamarine;
    static Color const Azure;
    static Color const Beige;
    static Color const Bisque;
    static Color const Black;
    static Color const BlanchedAlmond;
    static Color const Blue;
    static Color const BlueViolet;
    static Color const Brown;
    static Color const BurlyWood;
    static Color const CadetBlue;
    static Color const Chartreuse;
    static Color const Chocolate;
    static Color const Coral;
    static Color const CornflowerBlue;
    static Color const Cornsilk;
    static Color const Crimson;
    static Color const Cyan;
    static Color const DarkBlue;
    static Color const DarkCyan;
    static Color const DarkGoldenRod;
    static Color const DarkGray;
    static Color const DarkGrey;
    static Color const DarkGreen;
    static Color const DarkKhaki;
    static Color const DarkMagenta;
    static Color const DarkOliveGreen;
    static Color const DarkOrange;
    static Color const DarkOrchid;
    static Color const DarkRed;
    static Color const DarkSalmon;
    static Color const DarkSeaGreen;
    static Color const DarkSlateBlue;
    static Color const DarkSlateGray;
    static Color const DarkSlateGrey;
    static Color const DarkTurquoise;
    static Color const DarkViolet;
    static Color const DeepPink;
    static Color const DeepSkyBlue;
    static Color const DimGray;
    static Color const DimGrey;
    static Color const DodgerBlue;
    static Color const FireBrick;
    static Color const FloralWhite;
    static Color const ForestGreen;
    static Color const Fuchsia;
    static Color const Gainsboro;
    static Color const GhostWhite;
    static Color const Gold;
    static Color const GoldenRod;
    static Color const Gray;
    static Color const Grey;
    static Color const Green;
    static Color const GreenYellow;
    static Color const HoneyDew;
    static Color const HotPink;
    static Color const IndianRed;
    static Color const Indigo;
    static Color const Ivory;
    static Color const Khaki;
    static Color const Lavender;
    static Color const LavenderBlush;
    static Color const LawnGreen;
    static Color const LemonChiffon;
    static Color const LightBlue;
    static Color const LightCoral;
    static Color const LightCyan;
    static Color const LightGoldenRodYellow;
    static Color const LightGray;
    static Color const LightGrey;
    static Color const LightGreen;
    static Color const LightPink;
    static Color const LightSalmon;
    static Color const LightSeaGreen;
    static Color const LightSkyBlue;
    static Color const LightSlateGray;
    static Color const LightSlateGrey;
    static Color const LightSteelBlue;
    static Color const LightYellow;
    static Color const Lime;
    static Color const LimeGreen;
    static Color const Linen;
    static Color const Magenta;
    static Color const Maroon;
    static Color const MediumAquaMarine;
    static Color const MediumBlue;
    static Color const MediumOrchid;
    static Color const MediumPurple;
    static Color const MediumSeaGreen;
    static Color const MediumSlateBlue;
    static Color const MediumSpringGreen;
    static Color const MediumTurquoise;
    static Color const MediumVioletRed;
    static Color const MidnightBlue;
    static Color const MintCream;
    static Color const MistyRose;
    static Color const Moccasin;
    static Color const NavajoWhite;
    static Color const Navy;
    static Color const OldLace;
    static Color const Olive;
    static Color const OliveDrab;
    static Color const Orange;
    static Color const OrangeRed;
    static Color const Orchid;
    static Color const PaleGoldenRod;
    static Color const PaleGreen;
    static Color const PaleTurquoise;
    static Color const PaleVioletRed;
    static Color const PapayaWhip;
    static Color const PeachPuff;
    static Color const Peru;
    static Color const Pink;
    static Color const Plum;
    static Color const PowderBlue;
    static Color const Purple;
    static Color const RebeccaPurple;
    static Color const Red;
    static Color const RosyBrown;
    static Color const RoyalBlue;
    static Color const SaddleBrown;
    static Color const Salmon;
    static Color const SandyBrown;
    static Color const SeaGreen;
    static Color const SeaShell;
    static Color const Sienna;
    static Color const Silver;
    static Color const SkyBlue;
    static Color const SlateBlue;
    static Color const SlateGray;
    static Color const SlateGrey;
    static Color const Snow;
    static Color const SpringGreen;
    static Color const SteelBlue;
    static Color const Tan;
    static Color const Teal;
    static Color const Thistle;
    static Color const Tomato;
    static Color const Turquoise;
    static Color const Violet;
    static Color const Wheat;
    static Color const White;
    static Color const WhiteSmoke;
    static Color const Yellow;
    static Color const YellowGreen;

private:
    /**
      * Flag indicating if the color is valid
     */
    bool valid_ = false;
};

}
