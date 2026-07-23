type SoundName = 'select' | 'pitch' | 'swing' | 'hit' | 'homeRun' | 'out' | 'score'

export class GameAudio {
  private context: AudioContext | null = null
  private muted = false

  setMuted(muted: boolean): void {
    this.muted = muted
  }

  async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext()
    }
    if (this.context.state === 'suspended') {
      await this.context.resume()
    }
  }

  play(name: SoundName): void {
    if (this.muted) return
    void this.unlock().then(() => {
      if (!this.context) return
      const now = this.context.currentTime
      const patterns: Record<SoundName, Array<[number, number, number, OscillatorType]>> = {
        select: [[520, 0.05, 0, 'sine']],
        pitch: [
          [210, 0.07, 0, 'sine'],
          [360, 0.06, 0.05, 'sine'],
        ],
        swing: [
          [150, 0.08, 0, 'sawtooth'],
          [90, 0.1, 0.04, 'sine'],
        ],
        hit: [
          [120, 0.06, 0, 'square'],
          [260, 0.08, 0.025, 'triangle'],
        ],
        homeRun: [
          [392, 0.12, 0, 'square'],
          [523, 0.12, 0.11, 'square'],
          [659, 0.2, 0.22, 'square'],
        ],
        out: [
          [190, 0.11, 0, 'triangle'],
          [130, 0.18, 0.1, 'triangle'],
        ],
        score: [
          [660, 0.08, 0, 'sine'],
          [880, 0.14, 0.08, 'sine'],
        ],
      }

      patterns[name].forEach(([frequency, duration, delay, type]) => {
        const oscillator = this.context!.createOscillator()
        const gain = this.context!.createGain()
        oscillator.type = type
        oscillator.frequency.setValueAtTime(frequency, now + delay)
        gain.gain.setValueAtTime(0.0001, now + delay)
        gain.gain.exponentialRampToValueAtTime(0.13, now + delay + 0.01)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + duration)
        oscillator.connect(gain).connect(this.context!.destination)
        oscillator.start(now + delay)
        oscillator.stop(now + delay + duration + 0.02)
      })
    })
  }
}
