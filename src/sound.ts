// A short two-note chime made with the Web Audio API, so there is no audio file to load.
let context: AudioContext | undefined

// Browsers only allow audio after the user has interacted with the page. Creating the
// context on the first click or key press means later chimes can play while you're away.
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

export function playChime() {
  unlockSound()
  if (!context) return
  try {
    if (context.state === 'suspended') void context.resume().catch(() => {})
    const start = context.currentTime + 0.01
    // E6 then A6: a soft, rising "done" sound.
    for (const [index, frequency] of [1318.5, 1760].entries()) {
      const at = start + index * 0.11
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(0.12, at + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45)
      oscillator.connect(gain).connect(context.destination)
      oscillator.start(at)
      oscillator.stop(at + 0.5)
    }
  } catch {
    // Audio is a nice-to-have; ignore devices or browsers that refuse to play.
  }
}
