import SwiftUI
import UIKit

/// The app's colors. Light mode is the system's own. Dark mode is a touch softer than the
/// system's pure black with pure white text: the web app's dark background (#131313) and a
/// barely-off white for text, with cards a step lighter so they still stand out. Secondary and tertiary text follow from the text color.
extension Color {
    static let appBackground = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.075, alpha: 1) : .systemBackground })
    static let appText = Color(UIColor {
        $0.userInterfaceStyle == .dark ? UIColor(red: 0.945, green: 0.941, blue: 0.933, alpha: 1) : .label
    })
    /// Code blocks, cards, and placeholders.
    static let appSurface = Color(UIColor {
        $0.userInterfaceStyle == .dark ? UIColor(white: 0.125, alpha: 1) : .secondarySystemBackground
    })
}

extension View {
    /// A screen on the app's background, with its text in the app's text color.
    func appScreen() -> some View {
        foregroundStyle(Color.appText)
            .background(Color.appBackground.ignoresSafeArea())
    }
}

/// Settings → Appearance: System (follows iOS), Light, or Dark. Kept on this iPhone (the computer's
/// theme can differ). Set on the app's window, so sheets, menus, and alerts follow it at once.
enum AppTheme: String, CaseIterable, Identifiable {
    case system, light, dark

    static let key = "t3mini.theme"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    private var style: UIUserInterfaceStyle {
        switch self {
        case .system: .unspecified
        case .light: .light
        case .dark: .dark
        }
    }

    @MainActor
    static func apply(_ raw: String) {
        let style = (AppTheme(rawValue: raw) ?? .system).style
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            for window in scene.windows { window.overrideUserInterfaceStyle = style }
        }
    }
}
