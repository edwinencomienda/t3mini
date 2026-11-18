@preconcurrency import AVFoundation
import Foundation
import Observation

/// Live dictation, like the web app's: the microphone streams to the computer while you talk
/// (WebSocket /api/dictation/stream, relayed to its Deepgram key; src/server/dictation-stream.ts)
/// and the words come back as you say them. Audio is 16-bit PCM at 16 kHz, mono, converted from
/// the microphone on the fly, so nothing is written to disk. Stops by itself after five minutes.
@MainActor
@Observable
final class LiveDictation {
    static let maxSeconds: TimeInterval = 300

    private(set) var active = false
    /// Stopped; waiting for the last words.
    private(set) var finishing = false
    private(set) var elapsed: TimeInterval = 0
    /// 0…1, for the level meter.
    private(set) var level: Float = 0
    /// Everything heard so far: the settled words, then the ones still being worked out.
    var text: String { [committed, interim].filter { !$0.isEmpty }.joined(separator: " ") }

    private var committed = ""
    private var interim = ""
    private var engine: AVAudioEngine?
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var started = Date()
    private var timer: Timer?
    private var closed: CheckedContinuation<Void, Never>?
    private var isClosed = false
    private(set) var problem: String?

    /// Starts listening. Returns why it couldn't, or nil.
    func start(_ request: URLRequest) async -> String? {
        guard !active else { return nil }
        guard await AVAudioApplication.requestRecordPermission() else {
            return "Microphone not available. Allow it in iOS Settings → t3 mini."
        }
        let audio = AVAudioSession.sharedInstance()
        do {
            try audio.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try audio.setActive(true)
        } catch {
            return "Couldn’t start the microphone."
        }
        committed = ""
        interim = ""
        problem = nil
        isClosed = false

        let session = URLSession(configuration: .ephemeral)
        let socket = session.webSocketTask(with: request)
        socket.maximumMessageSize = 1 << 20
        socket.resume()
        self.session = session
        self.socket = socket
        receive(socket)

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0,
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: inputFormat, to: target)
        else {
            close()
            return "Couldn’t read the microphone."
        }
        let sender = AudioSender(socket: socket, converter: converter, target: target) { [weak self] level in
            Task { @MainActor in self?.level = level }
        }
        // The microphone calls this on its own audio thread: @Sendable keeps it off the main actor
        // (an actor-isolated closure here crashes on Swift's isolation check).
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { @Sendable buffer, _ in
            sender.send(buffer)
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            close()
            return "Couldn’t start the microphone."
        }
        self.engine = engine
        active = true
        started = Date()
        elapsed = 0
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.elapsed = Date().timeIntervalSince(self.started)
                if self.elapsed >= Self.maxSeconds { Task { await self.stop() } }
            }
        }
        return nil
    }

    /// Stops the microphone and waits (up to a few seconds) for the last words. Returns the text.
    @discardableResult
    func stop() async -> String {
        guard active else { return text }
        stopMicrophone()
        finishing = true
        socket?.send(.string(#"{"type":"stop"}"#)) { @Sendable _ in }
        // The computer sends the last results, then closes.
        // Gives up after four seconds, keeping what it has.
        let timeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(4))
            if !Task.isCancelled { self?.markClosed() }
        }
        await waitForClose()
        timeout.cancel()
        // Words still being worked out count too.
        if !interim.isEmpty {
            committed = text
            interim = ""
        }
        finishing = false
        close()
        return text
    }

    /// Stops without waiting (leaving the screen).
    func cancel() {
        guard active else { return }
        stopMicrophone()
        close()
    }

    private func stopMicrophone() {
        timer?.invalidate()
        timer = nil
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        active = false
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func close() {
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        session?.invalidateAndCancel()
        session = nil
        markClosed()
    }

    private func waitForClose() async {
        if isClosed { return }
        await withCheckedContinuation { continuation in
            if isClosed { continuation.resume() } else { closed = continuation }
        }
    }

    private func markClosed() {
        isClosed = true
        closed?.resume()
        closed = nil
    }

    // {"type":"transcript","text","final"} and {"type":"error","message"}.
    private func receive(_ socket: URLSessionWebSocketTask) {
        // URLSession calls back on its own queue; hop to the main actor for the state.
        socket.receive { @Sendable [weak self] result in
            Task { @MainActor in
                guard let self, self.socket === socket || self.finishing else { return }
                switch result {
                case .failure:
                    if self.active { self.problem = "Live dictation stopped: can’t reach your computer." }
                    self.markClosed()
                case .success(let message):
                    if case .string(let string) = message { self.handle(string) }
                    self.receive(socket)
                }
            }
        }
    }

    private func handle(_ string: String) {
        guard let data = string.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        switch message["type"] as? String {
        case "transcript":
            let words = (message["text"] as? String ?? "").trimmingCharacters(in: .whitespaces)
            if message["final"] as? Bool == true {
                if !words.isEmpty { committed = committed.isEmpty ? words : committed + " " + words }
                interim = ""
            } else {
                interim = words
            }
        case "error":
            problem = message["message"] as? String ?? "Dictation stopped."
        default:
            break
        }
    }
}

/// Runs on the audio thread: converts each microphone buffer to 16 kHz PCM and sends it.
private final class AudioSender: @unchecked Sendable {
    private let socket: URLSessionWebSocketTask
    private let converter: AVAudioConverter
    private let target: AVAudioFormat
    private let onLevel: @Sendable (Float) -> Void
    private var lastLevel = Date.distantPast

    init(socket: URLSessionWebSocketTask, converter: AVAudioConverter, target: AVAudioFormat,
         onLevel: @escaping @Sendable (Float) -> Void) {
        self.socket = socket
        self.converter = converter
        self.target = target
        self.onLevel = onLevel
    }

    func send(_ buffer: AVAudioPCMBuffer) {
        reportLevel(buffer)
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData else { return }
        let data = Data(bytes: samples[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
        socket.send(.data(data)) { @Sendable _ in }
    }

    // About ten times a second: -50 dB (quiet) … 0 dB (loud) → 0…1.
    private func reportLevel(_ buffer: AVAudioPCMBuffer) {
        guard Date().timeIntervalSince(lastLevel) > 0.1, let channel = buffer.floatChannelData?[0] else { return }
        lastLevel = Date()
        let count = Int(buffer.frameLength)
        guard count > 0 else { return }
        var sum: Float = 0
        for index in 0..<count { sum += channel[index] * channel[index] }
        let rms = (sum / Float(count)).squareRoot()
        let db = 20 * log10(max(rms, 0.000_01))
        onLevel(max(0, min(1, (db + 50) / 50)))
    }
}
