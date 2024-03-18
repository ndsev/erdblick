import {Injectable} from "@angular/core";
import {
    Color
} from "cesium";

// TODO: Improve the palette wrt color choices
const highlightPalette = [
    Color.YELLOW,
    Color.MEDIUMVIOLETRED,
    Color.MEDIUMSPRINGGREEN,
    Color.MEDIUMPURPLE,
    Color.PALETURQUOISE,
    Color.LIGHTGREEN,
    Color.LAVENDER,
    Color.GHOSTWHITE
]

const defaultColor = highlightPalette[0];

@Injectable({providedIn: 'root'})
export class HighlightService {
    pickedColor: Color = defaultColor;
    pickedOpacity: number = 100;

    setHighlightColor(color: Color) {
        this.pickedColor = color.withAlpha(this.pickedOpacity / 100);
    }

    setOpacity() {
        this.pickedColor = this.pickedColor.withAlpha(this.pickedOpacity / 100);
    }

    getHighlightPalette() {
        return highlightPalette;
    }
}