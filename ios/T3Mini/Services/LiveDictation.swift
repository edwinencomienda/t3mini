@preconcurrency import AVFoundation
import Foundation
import Observation
import Speech

/// Where dictation turns speech into text (Settings → Dictation).
enum DictationEngine: String, CaseIterable, Identifiable {
    /// Apple's speech recognition on the iPhone itself (iOS 26): no key, nothing leaves the phone.
    case iphone
    /// The computer's Deepgram key, streamed through t3 mini (the web app's live dictation).
    case computer

    static let key = "t3mini.dictationEngine"
    var id: String { rawValue }

    var label: String {
        switch self {
        case .iphone: "On this iPhone"
        case .computer: "Your computer"
        }
    }

    /// iOS 26 or later, on a device that supports it.
    static var onDeviceAvailable: Bool {
        if #available(iOS 26, *) { return SpeechTranscriber.isAvailable }
        return false
    }

    /// The chosen engine; this iPhone unless set otherwise (or it can't).
    static var current: DictationEngine {
        let saved = UserDefaults.standard.string(forKey: key).flatMap(DictationEngine.init(rawValue:))
        if saved == .computer || !onDeviceAvailable { return .computer }
        return .iphone
    }
}

/// Live dictation, like the web app's: the microphone streams to the computer while you talk
/// (WebSocket /api/dictation/stream, relayed to its Deepgram key; src/server/dictation-stream.ts)
/// and the words come back as you say them. Audio is 16-bit PCM at 16 kHz, mono, converted from
/// the microphone on the fly, so nothing is written to disk. Stops by itself after five minutes.
@MainActor
@Observable
final class LiveDictation {
    static let maxSeconds: TimeInterval = 300

    private(set) var active = false
    /// Getting ready (on this iPhone, the first time: downloading the language's speech model).
    private(set) var preparing = false
    /// Stopped; waiting for the last words.
    private(set) var finishing = false
    private(set) var elapsed: TimeInterval = 0
    /// 0…1, for the level meter.
    private(set) var level: Float = 0
    /// Everything heard so far: the settled words, then the ones still being worked out.
    var text: String { [committed, interim].filter { !$0.isEmpty }.joined(separator: " ") }

    /// Words Deepgram has settled on.
    private(set) var committed = ""
    /// Words it's still working out (shown muted; they may still change).
    private(set) var interim = ""
    private var engine: AVAudioEngine?
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var started = Date()
    private var timer: Timer?
    private var closed: CheckedContinuation<Void, Never>?
    private var isClosed = false
    private(set) var problem: String?

    /// On this iPhone (iOS 26): Apple's speech analyzer and its feed (`OnDeviceSpeech`).
    private var onDevice: AnyObject?

    /// Starts listening, on this iPhone or through the computer (`DictationEngine.current`; the
    /// computer needs `request`). Returns why it couldn't, or nil.
    func start(_ request: URLRequest?) async -> String? {
        guard !active, !preparing else { return nil }
        if DictationEngine.current == .iphone, #available(iOS 26, *) { return await startOnDevice() }
        guard let request else { return "Dictation through your computer needs its Deepgram key (t3 mini → Settings → Dictation)." }
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
        beginRecording()
        return nil
    }

    /// Listening: the start cue, the clock, and the five-minute limit (both engines).
    fileprivate func beginRecording() {
        active = true
        SoundEffects.recording = true
        // Like the web: two soft rising notes when it starts listening.
        SoundEffects.playCue(start: true)
        started = Date()
        elapsed = 0
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.elapsed = Date().timeIntervalSince(self.started)
                if self.elapsed >= Self.maxSeconds { Task { await self.stop() } }
            }
        }
    }

    /// Stops the microphone and waits (up to a few seconds) for the last words. Returns the text.
    @discardableResult
    func stop() async -> String {
        guard active else { return text }
        if #available(iOS 26, *), let speech = onDevice as? OnDeviceSpeech { return await stopOnDevice(speech) }
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
        if #available(iOS 26, *), let speech = onDevice as? OnDeviceSpeech {
            onDevice = nil
            Task { await speech.cancel() }
            return
        }
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
        SoundEffects.recording = false
        // And falling ones when it stops.
        SoundEffects.playCue(start: false)
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

// MARK: On this iPhone (iOS 26)

extension LiveDictation {
    /// Apple's on-device speech recognition: the microphone feeds Speech's analyzer, which reports
    /// words as they're said (shown muted) and then settles them. The language's model downloads
    /// once, the first time; after that it works offline, and the audio never leaves the phone.
    @available(iOS 26, *)
    fileprivate func startOnDevice() async -> String? {
        guard await AVAudioApplication.requestRecordPermission() else {
            return "Microphone not available. Allow it in iOS Settings → t3 mini."
        }
        preparing = true
        defer { preparing = false }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) else {
            return "Dictation on this iPhone doesn’t support your language yet. Switch to Your computer in Settings → Dictation."
        }
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [],
                                            reportingOptions: [.volatileResults], attributeOptions: [])
        do {
            if let download = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await download.downloadAndInstall()
            }
        } catch {
            return "Couldn’t get dictation ready on this iPhone. Check your connection and try again."
        }

        let audio = AVAudioSession.sharedInstance()
        do {
            try audio.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try audio.setActive(true)
        } catch {
            return "Couldn’t start the microphone."
        }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else { return "Couldn’t read the microphone." }
        let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: inputFormat)
            ?? inputFormat

        committed = ""
        interim = ""
        problem = nil
        let speech = OnDeviceSpeech(transcriber: transcriber, inputFormat: inputFormat, format: format) { [weak self] level in
            Task { @MainActor in self?.level = level }
        }
        // Words as they come (listening before the analyzer starts, so none are missed): muted
        // while Speech is still working them out, then settled.
        speech.results = Task { @MainActor [weak self] in
            do {
                for try await result in transcriber.results {
                    guard let self else { return }
                    let words = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    if result.isFinal {
                        if !words.isEmpty { self.committed = self.committed.isEmpty ? words : self.committed + " " + words }
                        self.interim = ""
                    } else {
                        self.interim = words
                    }
                }
            } catch {
                if let self, self.active { self.problem = "Dictation stopped." }
            }
        }
        do {
            try await speech.start()
        } catch {
            speech.results?.cancel()
            return "Couldn’t start dictation on this iPhone."
        }
        // The microphone calls this on its own audio thread (@Sendable, as for the computer).
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { @Sendable buffer, _ in
            speech.feed(buffer)
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            await speech.cancel()
            return "Couldn’t start the microphone."
        }
        self.engine = engine
        onDevice = speech
        beginRecording()
        return nil
    }

    /// Stops the microphone, lets Speech settle the last words (up to a few seconds), returns all.
    @available(iOS 26, *)
    fileprivate func stopOnDevice(_ speech: OnDeviceSpeech) async -> String {
        stopMicrophone()
        finishing = true
        await speech.finish(timeout: .seconds(4))
        if !interim.isEmpty {
            committed = text
            interim = ""
        }
        finishing = false
        onDevice = nil
        return text
    }
}

/// The analyzer and its audio feed. `feed` runs on the microphone's thread; the rest on the main actor.
@available(iOS 26, *)
private final class OnDeviceSpeech: @unchecked Sendable {
    private let analyzer: SpeechAnalyzer
    private let input: AsyncStream<AnalyzerInput>
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private let converter: AVAudioConverter?
    private let format: AVAudioFormat
    private let onLevel: @Sendable (Float) -> Void
    private var lastLevel = Date.distantPast
    var results: Task<Void, Never>?

    init(transcriber: SpeechTranscriber, inputFormat: AVAudioFormat, format: AVAudioFormat,
         onLevel: @escaping @Sendable (Float) -> Void) {
        analyzer = SpeechAnalyzer(modules: [transcriber])
        (input, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        self.format = format
        converter = inputFormat == format ? nil : AVAudioConverter(from: inputFormat, to: format)
        self.onLevel = onLevel
    }

    func start() async throws {
        try await analyzer.prepareToAnalyze(in: format)
        try await analyzer.start(inputSequence: input)
    }

    func feed(_ buffer: AVAudioPCMBuffer) {
        reportLevel(buffer)
        guard let converter else {
            continuation.yield(AnalyzerInput(buffer: buffer))
            return
        }
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
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
        guard error == nil, out.frameLength > 0 else { return }
        continuation.yield(AnalyzerInput(buffer: out))
    }

    /// No more audio: Speech settles what it heard; waits for its last results (or gives up).
    func finish(timeout: Duration) async {
        continuation.finish()
        let analyzer = analyzer
        let results = results
        let done = Task {
            try? await analyzer.finalizeAndFinishThroughEndOfInput()
            await results?.value
        }
        let deadline = Task {
            try? await Task.sleep(for: timeout)
            await analyzer.cancelAndFinishNow()
        }
        await done.value
        deadline.cancel()
    }

    func cancel() async {
        continuation.finish()
        results?.cancel()
        await analyzer.cancelAndFinishNow()
    }

    // About ten times a second: -50 dB (quiet) … 0 dB (loud) → 0…1, as for the computer.
    private func reportLevel(_ buffer: AVAudioPCMBuffer) {
        guard Date().timeIntervalSince(lastLevel) > 0.1, let channel = buffer.floatChannelData?[0] else { return }
        lastLevel = Date()
        let count = Int(buffer.frameLength)
        guard count > 0 else { return }
        var sum: Float = 0
        for index in 0..<count { sum += channel[index] * channel[index] }
        let rms = (sum / Float(count)).squareRoot()
        onLevel(max(0, min(1, (20 * log10(max(rms, 0.000_01)) + 50) / 50)))
    }
}
