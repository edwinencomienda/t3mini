// Completion sounds synthesized with the Web Audio API, so there are no audio files to load.
export type SoundName = 'chime' | 'marimba' | 'pop'
export const sounds: { value: SoundName; label: string }[] = [
  { value: 'chime', label: 'Soft chime' },
  { value: 'marimba', label: 'Marimba' },
  { value: 'pop', label: 'Pop' },
]
export const isSoundName = (value: unknown): value is SoundName =>
  sounds.some((sound) => sound.value === value)

let context: AudioContext | undefined

// Browsers only allow audio after the user has interacted with the page. Creating the
// context on the first click or key press means later sounds can play while you're away.
export function unlockSound() {
  if (typeof window === 'undefined' || context) return
  const Context = window.AudioContext
  if (!Context) return
  try {
    context = new Context()
    void context.resume().catch(() => {})
  } catch {
    context = undefined
  }
}

// One struck note: a fundamental plus quieter overtones that fade faster, like a real
// bell or bar. `partials` are [frequency ratio, relative volume, relative decay].
function strike(
  audio: AudioContext,
  output: AudioNode,
  {
    frequency,
    at,
    volume,
    decay,
    partials = [],
  }: {
    frequency: number
    at: number
    volume: number
    decay: number
    partials?: [number, number, number][]
  },
) {
  for (const [ratio, level, length] of [[1, 1, 1], ...partials] as [number, number, number][]) {
    const oscillator = audio.createOscillator()
    const gain = audio.createGain()
    const end = at + decay * length
    oscillator.type = 'sine'
    oscillator.frequency.value = frequency * ratio
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(volume * level, at + 0.006)
    gain.gain.exponentialRampToValueAtTime(0.0001, end)
    oscillator.connect(gain).connect(output)
    oscillator.start(at)
    oscillator.stop(end + 0.05)
  }
}

const voices: Record<SoundName, (audio: AudioContext, output: AudioNode, at: number) => void> = {
  // D5 then A5, a rising fifth with a soft bell overtone and a long, gentle tail.
  chime: (audio, output, at) => {
    const partials: [number, number, number][] = [
      [2, 0.18, 0.5],
      [3.01, 0.06, 0.3],
    ]
    strike(audio, output, { frequency: 587.33, at, volume: 0.09, decay: 1.1, partials })
    strike(audio, output, { frequency: 880, at: at + 0.13, volume: 0.08, decay: 1.4, partials })
  },
  // C5 then E5 with the marimba's characteristic fourth partial and a quick, woody decay.
  marimba: (audio, output, at) => {
    const partials: [number, number, number][] = [
      [3.9, 0.12, 0.25],
      [9.2, 0.03, 0.1],
    ]
    strike(audio, output, { frequency: 523.25, at, volume: 0.14, decay: 0.5, partials })
    strike(audio, output, { frequency: 659.25, at: at + 0.12, volume: 0.13, decay: 0.6, partials })
  },
  // A short upward pitch glide, like a soft bubble.
  pop: (audio, output, at) => {
    const oscillator = audio.createOscillator()
    const gain = audio.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(380, at)
    oscillator.frequency.exponentialRampToValueAtTime(920, at + 0.07)
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.16, at + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18)
    oscillator.connect(gain).connect(output)
    oscillator.start(at)
    oscillator.stop(at + 0.22)
  },
}

// Plays something through a gentle low-pass that takes the edge off the highest overtones.
function play(voice: (audio: AudioContext, output: AudioNode, at: number) => void) {
  unlockSound()
  if (!context) return
  try {
    if (context.state === 'suspended') void context.resume().catch(() => {})
    const filter = context.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 3200
    filter.connect(context.destination)
    voice(context, filter, context.currentTime + 0.02)
  } catch {
    // Audio is a nice-to-have; ignore devices or browsers that refuse to play.
  }
}

export function playSound(name: SoundName = 'chime') {
  play(voices[name])
}

// Dictation cues: two quick soft notes, rising (E5 → B5) when recording starts and falling when
// it stops, short enough not to get in the way of speaking.
export function playCue(kind: 'start' | 'stop') {
  const [first, second] = kind === 'start' ? [659.25, 987.77] : [987.77, 659.25]
  play((audio, output, at) => {
    strike(audio, output, { frequency: first, at, volume: 0.07, decay: 0.12 })
    strike(audio, output, { frequency: second, at: at + 0.07, volume: 0.07, decay: 0.18 })
  })
}
