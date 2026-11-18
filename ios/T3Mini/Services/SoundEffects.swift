import AVFoundation
import Foundation

/// The web app's sounds (src/sound.ts), synthesized here the same way: no audio files. A chime,
/// marimba, or pop when an agent finishes, and two soft notes when dictation starts (rising) and
/// stops (falling). They follow the silent switch and mix with whatever else is playing.
/// Settings → Sounds turns them off (per phone, like the web's per-browser setting).
@MainActor
enum SoundEffects {
    enum Finish: String, CaseIterable, Identifiable {
        case chime, marimba, pop
        var id: String { rawValue }
        var label: String {
            switch self {
            case .chime: "Soft chime"
            case .marimba: "Marimba"
            case .pop: "Pop"
            }
        }
    }

    static let finishKey = "sound.finish"
    static let finishNameKey = "sound.name"
    static let dictationKey = "sound.dictation"

    static var finishOn: Bool { UserDefaults.standard.object(forKey: finishKey) as? Bool ?? true }
    static var dictationOn: Bool { UserDefaults.standard.object(forKey: dictationKey) as? Bool ?? true }
    static var finishSound: Finish {
        Finish(rawValue: UserDefaults.standard.string(forKey: finishNameKey) ?? "") ?? .chime
    }

    /// An agent finished (the app is open; in the background, the notification has its own).
    static func playFinish(_ sound: Finish? = nil, force: Bool = false) {
        guard force || finishOn else { return }
        play(key: "finish-\((sound ?? finishSound).rawValue)") { Synth.finish(sound ?? finishSound) }
    }

    /// Dictation started or stopped.
    static func playCue(start: Bool, force: Bool = false) {
        guard force || dictationOn else { return }
        play(key: start ? "cue-start" : "cue-stop") { Synth.cue(start: start) }
    }

    /// Dictation is recording: its audio session stays as it is (playback works in it too).
    static var recording = false
    private static var players: [String: AVAudioPlayer] = [:]

    private static func play(key: String, render: () -> [Float]) {
        let session = AVAudioSession.sharedInstance()
        // While dictating, the session is already set up for recording and playback; otherwise
        // a gentle one: follows the silent switch, doesn't stop music.
        if !recording {
            try? session.setCategory(.ambient, options: [.mixWithOthers])
            try? session.setActive(true)
        }
        if players[key] == nil, let player = try? AVAudioPlayer(data: Synth.wav(render())) {
            player.prepareToPlay()
            players[key] = player
        }
        guard let player = players[key] else { return }
        player.currentTime = 0
        player.play()
    }
}

/// Renders the sounds into samples: struck notes made of a fundamental and quieter overtones
/// that fade faster (like a bell or a bar), through a gentle low-pass, as the web does.
enum Synth {
    static let rate = 44_100.0

    static func finish(_ sound: SoundEffects.Finish) -> [Float] {
        switch sound {
        case .chime:
            // D5 then A5: a rising fifth with a soft bell overtone and a long tail.
            let partials: [(Double, Double, Double)] = [(2, 0.18, 0.5), (3.01, 0.06, 0.3)]
            return mix(length: 1.7, [
                strike(587.33, at: 0, volume: 0.09, decay: 1.1, partials: partials),
                strike(880, at: 0.13, volume: 0.08, decay: 1.4, partials: partials),
            ])
        case .marimba:
            // C5 then E5 with the marimba's fourth partial and a quick, woody decay.
            let partials: [(Double, Double, Double)] = [(3.9, 0.12, 0.25), (9.2, 0.03, 0.1)]
            return mix(length: 0.85, [
                strike(523.25, at: 0, volume: 0.14, decay: 0.5, partials: partials),
                strike(659.25, at: 0.12, volume: 0.13, decay: 0.6, partials: partials),
            ])
        case .pop:
            // A short upward glide, like a soft bubble.
            return lowPass(glide(from: 380, to: 920, glideTime: 0.07, volume: 0.16, end: 0.18, length: 0.24))
        }
    }

    /// E5 → B5 when recording starts, B5 → E5 when it stops: short enough not to get in the way.
    static func cue(start: Bool) -> [Float] {
        let (first, second) = start ? (659.25, 987.77) : (987.77, 659.25)
        return mix(length: 0.32, [
            strike(first, at: 0, volume: 0.07, decay: 0.12, partials: []),
            strike(second, at: 0.07, volume: 0.07, decay: 0.18, partials: []),
        ])
    }

    /// One struck note (sine partials): a 6 ms rise, then an exponential fade to silence by
    /// `decay` × each partial's own length.
    static func strike(_ frequency: Double, at start: Double, volume: Double, decay: Double,
                       partials: [(Double, Double, Double)]) -> (start: Double, samples: [Float]) {
        let all = [(1.0, 1.0, 1.0)] + partials
        let longest = all.map { decay * $0.2 }.max() ?? decay
        let count = Int((longest + 0.05) * rate)
        var out = [Float](repeating: 0, count: count)
        for (ratio, level, length) in all {
            let end = decay * length
            let peak = volume * level
            let freq = frequency * ratio
            for index in 0..<min(count, Int(end * rate)) {
                let t = Double(index) / rate
                let envelope = t < 0.006 ? peak * t / 0.006 : peak * pow(0.0001 / peak, (t - 0.006) / max(end - 0.006, 0.001))
                out[index] += Float(envelope * sin(2 * .pi * freq * t))
            }
        }
        return (start, out)
    }

    static func glide(from: Double, to: Double, glideTime: Double, volume: Double, end: Double, length: Double) -> [Float] {
        let count = Int(length * rate)
        var out = [Float](repeating: 0, count: count)
        var phase = 0.0
        for index in 0..<count {
            let t = Double(index) / rate
            let frequency = t < glideTime ? from * pow(to / from, t / glideTime) : to
            phase += 2 * .pi * frequency / rate
            let envelope = t < 0.008 ? volume * t / 0.008 : (t < end ? volume * pow(0.0001 / volume, (t - 0.008) / (end - 0.008)) : 0)
            out[index] = Float(envelope * sin(phase))
        }
        return out
    }

    static func mix(length: Double, _ notes: [(start: Double, samples: [Float])]) -> [Float] {
        var out = [Float](repeating: 0, count: Int(length * rate))
        for note in notes {
            let offset = Int(note.start * rate)
            for (index, sample) in note.samples.enumerated() where offset + index < out.count {
                out[offset + index] += sample
            }
        }
        return lowPass(out)
    }

    /// Takes the edge off the highest overtones (3.2 kHz, like the web's BiquadFilter).
    static func lowPass(_ samples: [Float], cutoff: Double = 3200) -> [Float] {
        let alpha = Float(1 - exp(-2 * .pi * cutoff / rate))
        var last: Float = 0
        return samples.map { sample in
            last += alpha * (sample - last)
            return last
        }
    }

    /// 16-bit mono WAV, for AVAudioPlayer.
    static func wav(_ samples: [Float]) -> Data {
        var data = Data()
        func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        let bytes = samples.count * 2
        data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36 + bytes))
        data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
        append(UInt32(rate)); append(UInt32(rate * 2)); append(UInt16(2)); append(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); append(UInt32(bytes))
        for sample in samples { append(Int16(max(-1, min(1, sample)) * Float(Int16.max))) }
        return data
    }
}
