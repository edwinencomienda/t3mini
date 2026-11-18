import SwiftUI

/// The web app's avatar colors (src/components/ProjectAvatar.tsx and styles.css).
enum AvatarColor {
    /// `hash = (hash * 31 + char.charCodeAt(0)) >>> 0` over the name's code points, then % 360.
    static func hue(_ name: String) -> Double {
        var hash: UInt32 = 0
        for scalar in name.unicodeScalars {
            let code = UInt32(String(scalar).utf16.first ?? 0)
            hash = hash &* 31 &+ code
        }
        return Double(hash % 360)
    }

    /// CSS `oklch(L C h)` as an sRGB color.
    static func oklch(_ lightness: Double, _ chroma: Double, _ hue: Double) -> Color {
        let radians = hue * .pi / 180
        let a = chroma * cos(radians), b = chroma * sin(radians)
        let l = pow(lightness + 0.3963377774 * a + 0.2158037573 * b, 3)
        let m = pow(lightness - 0.1055613458 * a - 0.0638541728 * b, 3)
        let s = pow(lightness - 0.0894841775 * a - 1.2914855480 * b, 3)
        func encode(_ x: Double) -> Double {
            let value = x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055
            return min(1, max(0, value))
        }
        return Color(.sRGB,
                     red: encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
                     green: encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
                     blue: encode(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s))
    }
}

extension AvatarColor {
    /// A project's letter, as on the web: its first letter or digit.
    static func initial(_ name: String) -> String {
        name.first(where: { $0.isLetter || $0.isNumber }).map { String($0).uppercased() } ?? "?"
    }
}
