import AVFoundation
import AVKit
import SwiftUI

// Cards for agent tools in a reply, like the web app's: the to-do checklist (update_checklist),
// status cards (show_status), sub-agent cards (delegate_task), and video / sound (show_video,
// play_audio).

/// The agent's to-do list, updating in place: done items checked, the current one spinning, the
/// rest waiting. `ended`: the turn is over, so the item it was on stops spinning.
struct TodoCard: View {
    let todos: [Todo]
    var ended = false

    private var done: Int { todos.filter { $0.status == "completed" }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("To-do", systemImage: "checklist").font(.footnote.weight(.semibold))
                Spacer()
                Text("\(done) of \(todos.count)").font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
            }
            .foregroundStyle(.secondary)
            ForEach(todos) { todo in
                HStack(alignment: .firstTextBaseline, spacing: 9) {
                    // Centered on the first line of text: a hidden letter in the row's font sets
                    // the line (a spinner has no baseline of its own, so it dropped below it).
                    Text("X").font(.footnote).hidden().frame(width: 16).overlay { icon(todo) }
                    Text(todo.status == "in_progress" && !ended ? (todo.activeText ?? todo.text) : todo.text)
                        .font(.footnote)
                        .strikethrough(todo.status == "completed", color: .secondary)
                        .foregroundStyle(todo.status == "completed" ? .secondary : .primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityValue(todo.status == "completed" ? "done" : todo.status == "in_progress"
                                    ? (ended ? "not finished" : "in progress") : "")
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appSurface, in: .rect(cornerRadius: 14))
    }

    @ViewBuilder private func icon(_ todo: Todo) -> some View {
        switch todo.status {
        case "completed": Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).font(.footnote)
        case "in_progress" where !ended: ProgressView().controlSize(.mini)
        case "in_progress": Image(systemName: "circle.dotted").foregroundStyle(.orange).font(.footnote)
        default: Image(systemName: "circle").foregroundStyle(.tertiary).font(.footnote)
        }
    }
}

/// show_status: what it is (push, pull request, deploy, release, task), its stages with the
/// current one marked, commits, the error lines when it failed, the link, and how long it took.
struct StatusCard: View {
    let info: StatusInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: kindIcon).font(.body).foregroundStyle(statusColor).frame(width: 22)
                VStack(alignment: .leading, spacing: 3) {
                    Text(info.title).font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                    if let detail = info.detail, !detail.isEmpty {
                        Text(detail).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                Spacer(minLength: 6)
                statusBadge
            }
            if let stages = info.stages, !stages.isEmpty { stageRow(stages) }
            if let commits = info.commits, !commits.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(commits.prefix(6).enumerated()), id: \.offset) { _, commit in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(String(commit.sha.prefix(7))).font(.caption.monospaced()).foregroundStyle(.secondary)
                            Text(commit.message).font(.footnote).lineLimit(1)
                        }
                    }
                    if commits.count > 6 {
                        Text("\(commits.count - 6) more").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if info.status == "failed", let error = info.error, !error.isEmpty {
                Text(error)
                    .font(.caption.monospaced())
                    .foregroundStyle(.red)
                    .lineLimit(6)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.08), in: .rect(cornerRadius: 8))
            }
            // https only, like the web app (checked on the server too).
            if let link = info.url, let url = URL(string: link), url.scheme == "https" {
                Link(destination: url) {
                    Label(info.urlLabel ?? url.host() ?? "Open", systemImage: "arrow.up.right.square")
                        .font(.footnote.weight(.medium))
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appSurface, in: .rect(cornerRadius: 14))
        .accessibilityElement(children: .contain)
    }

    private var kindIcon: String {
        switch info.kind {
        case "push": "arrow.up.circle"
        case "pr": "arrow.triangle.pull"
        case "deploy": "paperplane"
        case "release": "tag"
        default: "checklist"
        }
    }

    private var statusColor: Color {
        switch info.status {
        case "done": .green
        case "failed": .red
        case "stopped": .secondary
        default: .accentColor
        }
    }

    @ViewBuilder private var statusBadge: some View {
        HStack(spacing: 5) {
            if info.status == "running" { ProgressView().controlSize(.mini) }
            Text(duration.map { "\(statusWord) · \($0)" } ?? statusWord)
                .font(.caption.weight(.medium).monospacedDigit())
        }
        .foregroundStyle(statusColor)
    }

    private var statusWord: String {
        switch info.status {
        case "done": "Done"
        case "failed": "Failed"
        case "stopped": "Stopped"
        default: "Running"
        }
    }

    private var duration: String? {
        guard let start = info.startedAt.flatMap(RelativeTime.parse),
              let end = info.endedAt.flatMap(RelativeTime.parse), end >= start else { return nil }
        return Turn.duration(end.timeIntervalSince(start))
    }

    private func stageRow(_ stages: [String]) -> some View {
        let current = info.stage.flatMap { stages.firstIndex(of: $0) } ?? (info.status == "done" ? stages.count - 1 : 0)
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(stages.enumerated()), id: \.offset) { index, stage in
                    let finished = index < current || (index == current && info.status == "done")
                    let failedHere = index == current && info.status == "failed"
                    HStack(spacing: 4) {
                        Image(systemName: finished ? "checkmark" : failedHere ? "xmark" : index == current ? "circle.fill" : "circle")
                            .font(.system(size: 8, weight: .bold))
                        Text(stage).font(.caption)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .foregroundStyle(failedHere ? .red : index <= current ? .primary : .secondary)
                    .background(index == current ? statusColor.opacity(0.15) : Color(.tertiarySystemFill), in: Capsule())
                    if index < stages.count - 1 {
                        Image(systemName: "chevron.right").font(.system(size: 8)).foregroundStyle(.tertiary)
                    }
                }
            }
        }
    }
}

/// delegate_task: another agent working on a task for this thread. Its agent and access, what
/// it's doing, its checklist progress, the files it changed (and overlaps with another sub-agent),
/// its answer or error. Tap to open its own thread.
struct DelegationCard: View {
    let info: DelegationInfo
    @Environment(AppModel.self) private var model
    @State private var showFiles = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                AgentLogo(provider: info.agent ?? .claude, size: 18).padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    Text(info.title).font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                    Text(meta).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                badge
            }
            if let step = info.step, !step.isEmpty, info.status == "running" || info.status == "waiting" {
                Text(step).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
            }
            if let progress = info.todos, progress.total > 0 {
                ProgressView(value: Double(progress.done), total: Double(progress.total)) {
                    Text("\(progress.done) of \(progress.total) to-dos").font(.caption).foregroundStyle(.secondary)
                }
                .tint(statusColor)
            }
            if let files = info.files, !files.isEmpty {
                Button { withAnimation(.snappy) { showFiles.toggle() } } label: {
                    HStack(spacing: 4) {
                        Text("\(files.count) file\(files.count == 1 ? "" : "s") changed")
                        Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
                            .rotationEffect(.degrees(showFiles ? 90 : 0))
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                if showFiles {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(files.prefix(30), id: \.self) { file in
                            Text(file).font(.caption.monospaced()).lineLimit(1).truncationMode(.head)
                                .foregroundStyle((info.overlaps ?? []).contains(file) ? .orange : .secondary)
                        }
                    }
                }
            }
            if let overlaps = info.overlaps, !overlaps.isEmpty {
                Label("Another sub-agent changed \(overlaps.count == 1 ? overlaps[0] : "\(overlaps.count) of the same files") too",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if info.status == "failed", let error = info.error, !error.isEmpty {
                Text(error).font(.footnote).foregroundStyle(.red).lineLimit(4)
            } else if let answer = info.answer, !answer.isEmpty, info.status == "done" {
                Text(answer).font(.footnote).foregroundStyle(.secondary).lineLimit(4)
            }
            if let id = info.id {
                Button { model.pushThread = id } label: {
                    Label("Open its thread", systemImage: "arrow.right.circle").font(.footnote.weight(.medium))
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appSurface, in: .rect(cornerRadius: 14))
    }

    private var meta: String {
        var parts = ["Sub-agent", info.agent == .codex ? "Codex" : "Claude"]
        parts.append(info.access == "read-only" ? "Read-only" : "Can edit")
        if info.background == true { parts.append("In the background") }
        if let start = info.startedAt.flatMap(RelativeTime.parse), let end = info.endedAt.flatMap(RelativeTime.parse), end >= start {
            parts.append(Turn.duration(end.timeIntervalSince(start)))
        }
        return parts.joined(separator: " · ")
    }

    private var statusColor: Color {
        switch info.status {
        case "done": .green
        case "failed": .red
        case "waiting": .orange
        case "stopped": .secondary
        default: .accentColor
        }
    }

    private var badge: some View {
        HStack(spacing: 5) {
            if info.status == "running" { ProgressView().controlSize(.mini) }
            Text(info.status == "done" ? "Done" : info.status == "failed" ? "Failed" : info.status == "waiting" ? "Waiting"
                 : info.status == "stopped" ? "Stopped" : "Working")
                .font(.caption.weight(.medium))
        }
        .foregroundStyle(statusColor)
    }
}

/// show_video / play_audio: tap to load it from the computer (with this phone's session), then
/// it plays in iOS's own player. Kept for the session, so a second play starts at once.
struct MediaCard: View {
    enum Kind { case video, audio }
    let id: String
    let caption: String?
    let kind: Kind
    @Environment(AppModel.self) private var model
    @State private var player: AVPlayer?
    @State private var loading = false
    @State private var problem: String?
    @State private var playing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if kind == .video, let player {
                VideoPlayer(player: player)
                    .aspectRatio(16 / 9, contentMode: .fit)
                    .clipShape(.rect(cornerRadius: 12))
            } else {
                HStack(spacing: 12) {
                    Button { Task { await togglePlay() } } label: {
                        ZStack {
                            Circle().fill(Color.accentColor.opacity(0.15))
                            if loading { ProgressView().controlSize(.small) } else {
                                Image(systemName: playing ? "pause.fill" : "play.fill").foregroundStyle(Color.accentColor)
                            }
                        }
                        .frame(width: 40, height: 40)
                    }
                    .buttonStyle(.plain)
                    .disabled(loading)
                    .accessibilityLabel(playing ? "Pause" : "Play")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(caption ?? (kind == .video ? "Video" : "Sound")).font(.subheadline.weight(.medium)).lineLimit(2)
                        Text(problem ?? (kind == .video ? "Tap to play" : (playing ? "Playing" : "Tap to play")))
                            .font(.caption)
                            .foregroundStyle(problem == nil ? .secondary : Color.red)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: kind == .video ? "film" : "waveform").foregroundStyle(.secondary)
                }
            }
            if kind == .video, player != nil, let caption, !caption.isEmpty {
                Text(caption).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appSurface, in: .rect(cornerRadius: 14))
        .onDisappear { player?.pause(); playing = false }
        .onReceive(NotificationCenter.default.publisher(for: AVPlayerItem.didPlayToEndTimeNotification)) { note in
            guard let item = note.object as? AVPlayerItem, item === player?.currentItem else { return }
            playing = false
            player?.seek(to: .zero)
        }
    }

    private func togglePlay() async {
        if let player {
            if playing { player.pause(); playing = false } else { startPlayback(player) }
            return
        }
        loading = true
        problem = nil
        defer { loading = false }
        do {
            let file = try await model.mediaFile(id)
            let player = AVPlayer(url: file)
            self.player = player
            startPlayback(player)
        } catch {
            problem = "Couldn’t load it from your computer."
        }
    }

    private func startPlayback(_ player: AVPlayer) {
        // Plays even with the ring switch on silent, like other media apps.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
        player.play()
        playing = true
    }
}
