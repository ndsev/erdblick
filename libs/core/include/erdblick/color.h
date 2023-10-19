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
      * - A CSS color name: https://www.w3.org/wiki/CSS/Properties/color/keywords
      * If none of these formats matches the input, the resulting color will be invalid.
     */
    Color(const char* colorString);
    Color(const std::string& colorString);

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

private:
    /**
      * Flag indicating if the color is valid
     */
    bool valid_ = false;

    /**
     * Map of supported CSS color names from here:
     * https://www.w3.org/wiki/CSS/Properties/color/keywords
     */
    static const std::map<std::string, Color> cssColors;
};

}
