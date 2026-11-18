import SwiftUI

/// A project's round avatar, like the web app's: the image chosen for it or its own icon
/// (favicon, app icon), loaded from the computer; its colored first letter until then, or when it
/// has none. "No project" chats get a chat bubble.
struct ProjectAvatar: View {
    let name: String
    var project: ProjectSummary?
    var size: CGFloat = 48
    /// Rounded square, like the web sidebar's small avatars (circle: like a contact photo).
    var square = false
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var scheme
    @State private var image: UIImage?

    init(name: String, project: ProjectSummary? = nil, size: CGFloat = 48, square: Bool = false,
         cached: UIImage? = nil) {
        self.name = name
        self.project = project
        self.size = size
        self.square = square
        _image = State(initialValue: cached)
    }

    var body: some View {
        ZStack {
            if project?.chats == true {
                Rectangle().fill(Color(.secondarySystemFill))
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.system(size: size * 0.38))
                    .foregroundStyle(.secondary)
            } else if let image {
                // Like the web: no box around it. A chosen image fills the square, a project's own
                // icon is shown whole.
                if project?.avatar == "image" {
                    Image(uiImage: image).resizable().scaledToFill().frame(width: size, height: size)
                } else {
                    Image(uiImage: image).resizable().scaledToFit().frame(width: size, height: size)
                }
            } else {
                // The web's letter avatar: a soft tint of the project's color, the letter in it.
                let dark = scheme == .dark
                Rectangle().fill(AvatarColor.oklch(0.62, 0.12, hue).opacity(dark ? 0.22 : 0.16))
                Text(initial)
                    .font(.system(size: size * 0.45, weight: .bold))
                    .foregroundStyle(dark ? AvatarColor.oklch(0.82, 0.11, hue) : AvatarColor.oklch(0.5, 0.14, hue))
            }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .accessibilityHidden(true)
        // Reload when the choice changes on the computer (avatar, image, icon on/off). Already
        // decoded: shown at once, with no letter in between.
        // Also when the icon changed on the computer (checked in the background, avatarRevision).
        .task(id: "\(avatarKey)|\(model.avatarRevision)") {
            guard let project else { image = nil; return }
            if let cached = model.cachedAvatar(project) { image = cached; return }
            image = await model.loadAvatar(project)
        }
    }

    private var shape: AnyShape {
        square ? AnyShape(RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)) : AnyShape(Circle())
    }

    private var avatarKey: String {
        project.map { model.avatarKey($0) } ?? name
    }

    private var initial: String {
        name.first(where: { $0.isLetter || $0.isNumber }).map { String($0).uppercased() } ?? "?"
    }

    /// The same hue as the web app's (ProjectAvatar.tsx), so a project keeps its color everywhere.
    private var hue: Double { AvatarColor.hue(name) }
}

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

/// Short time for list rows: "14:05" today, "Yesterday", weekday this week, else the date.
enum RelativeTime {
    static func label(_ iso: String, now: Date = Date()) -> String {
        guard let date = parse(iso) else { return "" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if let days = calendar.dateComponents([.day], from: date, to: now).day, days < 7 {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(date: .numeric, time: .omitted)
    }

    // Made once: creating a date formatter is slow, and lists parse dates on every redraw.
    // ISO8601DateFormatter is safe to use from any thread.
    nonisolated(unsafe) private static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    nonisolated(unsafe) private static let plain = ISO8601DateFormatter()

    /// Parsed dates, remembered: the same timestamps are read again on every live update (list
    /// rows, the chat's turns), and parsing is the slow part. NSCache is safe from any thread.
    nonisolated(unsafe) private static let parsed: NSCache<NSString, NSDate> = {
        let cache = NSCache<NSString, NSDate>()
        cache.countLimit = 20_000
        return cache
    }()

    nonisolated static func parse(_ iso: String) -> Date? {
        let key = iso as NSString
        if let hit = parsed.object(forKey: key) { return hit as Date }
        guard let date = withFraction.date(from: iso) ?? plain.date(from: iso) else { return nil }
        parsed.setObject(date as NSDate, forKey: key)
        return date
    }
}
