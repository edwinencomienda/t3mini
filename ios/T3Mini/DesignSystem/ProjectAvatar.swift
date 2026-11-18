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
                // Icons are often square with their own background: a light backdrop and a ring
                // keep transparent and white ones visible in both light and dark mode.
                Rectangle().fill(Color(.secondarySystemBackground))
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
            } else {
                Rectangle().fill(color.gradient)
                Text(initial)
                    .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay { if image != nil { shape.stroke(Color(.separator).opacity(0.5), lineWidth: 0.5) } }
        .accessibilityHidden(true)
        // Reload when the choice changes on the computer (avatar, image, icon on/off). Already
        // decoded: shown at once, with no letter in between.
        .task(id: avatarKey) {
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

    private var color: Color {
        let palette: [Color] = [.indigo, .blue, .teal, .green, .orange, .pink, .purple, .red, .cyan, .mint]
        let hash = name.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0x7fffffff }
        return palette[hash % palette.count]
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

    nonisolated static func parse(_ iso: String) -> Date? {
        withFraction.date(from: iso) ?? plain.date(from: iso)
    }
}
