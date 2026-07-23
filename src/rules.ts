import type {
  Bases,
  ContactRatings,
  ContactResult,
  Count,
  CpuProfile,
  Difficulty,
  Half,
  InningTransition,
  RunnerAdvance,
  RunnerSlot,
  Score,
} from './types'

export const emptyBases = (): Bases => ({ first: null, second: null, third: null })

export const emptyCount = (): Count => ({ balls: 0, strikes: 0, outs: 0 })

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value))

export const normalizeRating = (rating: number): number => clamp((rating - 70) / 25, -1, 1)

export function applyPitchCall(
  count: Count,
  call: 'ball' | 'strike' | 'foul',
): { count: Count; result: 'continue' | 'walk' | 'strikeout' } {
  if (call === 'ball') {
    const balls = count.balls + 1
    if (balls >= 4) {
      return {
        count: { balls: 0, strikes: 0, outs: count.outs },
        result: 'walk',
      }
    }
    return { count: { ...count, balls }, result: 'continue' }
  }

  if (call === 'foul') {
    return {
      count: { ...count, strikes: Math.min(2, count.strikes + 1) },
      result: 'continue',
    }
  }

  const strikes = count.strikes + 1
  if (strikes >= 3) {
    return {
      count: { balls: 0, strikes: 0, outs: count.outs + 1 },
      result: 'strikeout',
    }
  }
  return { count: { ...count, strikes }, result: 'continue' }
}

export function recordOut(count: Count): Count {
  return { balls: 0, strikes: 0, outs: count.outs + 1 }
}

export function walkRunners(bases: Bases, batter: RunnerSlot): RunnerAdvance {
  const next = { ...bases }
  let runs = 0

  if (bases.first) {
    if (bases.second) {
      if (bases.third) runs += 1
      next.third = bases.second
    }
    next.second = bases.first
  }
  next.first = batter

  return { bases: next, runs }
}

function extraBaseChance(speed: number, baseChance: number): number {
  return clamp(baseChance + normalizeRating(speed) * 0.2, 0.1, 0.95)
}

export function advanceRunners(
  bases: Bases,
  hitBases: 1 | 2 | 3 | 4,
  batter: RunnerSlot,
  random: () => number = Math.random,
): RunnerAdvance {
  if (hitBases === 4) {
    const runners = [bases.first, bases.second, bases.third].filter(Boolean).length
    return { bases: emptyBases(), runs: runners + 1 }
  }
  if (hitBases === 3) {
    const runners = [bases.first, bases.second, bases.third].filter(Boolean).length
    return { bases: { first: null, second: null, third: batter }, runs: runners }
  }
  if (hitBases === 2) {
    let runs = Number(Boolean(bases.third)) + Number(Boolean(bases.second))
    let third: RunnerSlot | null = null
    if (bases.first) {
      if (random() < extraBaseChance(bases.first.speed, 0.65)) runs += 1
      else third = bases.first
    }
    return { bases: { first: null, second: batter, third }, runs }
  }

  let runs = Number(Boolean(bases.third))
  let third: RunnerSlot | null = null
  let second: RunnerSlot | null = null
  if (bases.second) {
    if (random() < extraBaseChance(bases.second.speed, 0.7)) runs += 1
    else third = bases.second
  }
  if (bases.first) {
    if (!third && random() < extraBaseChance(bases.first.speed, 0.35)) third = bases.first
    else second = bases.first
  }
  return { bases: { first: batter, second, third }, runs }
}

const defaultContactRatings: ContactRatings = {
  contact: 70,
  power: 70,
  clutch: 70,
  pitcherStuff: 70,
  pitcherPrevention: 70,
  runnersInScoringPosition: false,
}

export function resolveContact(
  timingError: number,
  aimError: number,
  roll: number,
  ratings: ContactRatings = defaultContactRatings,
): ContactResult {
  const contact = normalizeRating(ratings.contact)
  const stuff = normalizeRating(ratings.pitcherStuff)
  const power = normalizeRating(ratings.power)
  const prevention = normalizeRating(ratings.pitcherPrevention)
  const clutch = ratings.runnersInScoringPosition ? normalizeRating(ratings.clutch) : 0
  const timingTolerance = 0.28 * clamp(1 + contact * 0.12 - stuff * 0.1 + clutch * 0.06, 0.75, 1.25)
  const aimTolerance = 0.95 * clamp(1 + contact * 0.1 - stuff * 0.08, 0.78, 1.22)

  if (timingError > timingTolerance || aimError > aimTolerance) return 'miss'

  const timingQuality = timingError / timingTolerance
  const aimQuality = aimError / aimTolerance
  const quality = clamp(
    1 - timingQuality * 0.58 - aimQuality * 0.42 + power * 0.12 - prevention * 0.08 + clutch * 0.05,
    0,
    1,
  )

  if (quality < 0.28) return roll < 0.64 ? 'foul' : 'out'
  if (quality < 0.48) {
    if (roll < 0.3) return 'foul'
    if (roll < 0.78) return 'out'
    return 'single'
  }
  if (quality < 0.68) {
    if (roll < 0.28) return 'out'
    if (roll < 0.72) return 'single'
    if (roll < 0.93) return 'double'
    return 'triple'
  }
  if (quality < 0.84) {
    if (roll < 0.18) return 'out'
    if (roll < 0.48) return 'single'
    if (roll < 0.77) return 'double'
    if (roll < 0.86) return 'triple'
    return 'homeRun'
  }
  if (roll < 0.1) return 'out'
  if (roll < 0.28) return 'single'
  if (roll < 0.56) return 'double'
  if (roll < 0.65) return 'triple'
  return 'homeRun'
}

export function pitcherFatiguePenalty(battersFaced: number, stamina: number): number {
  if (battersFaced <= 6) return 0
  const lossPerBatter = 1.2 - normalizeRating(stamina) * 0.6
  return Math.min(12, (battersFaced - 6) * lossPerBatter)
}

export function effectivePitcherRating(
  rating: number,
  stamina: number,
  battersFaced: number,
): number {
  return clamp(rating - pitcherFatiguePenalty(battersFaced, stamina), 45, 95)
}

export function pitcherSpeedMultiplier(stuff: number): number {
  return 1 + normalizeRating(stuff) * 0.08
}

export function pitcherBreakMultiplier(stuff: number): number {
  return 1 + normalizeRating(stuff) * 0.15
}

export function controlJitter(control: number): number {
  return 0.11 * (1 - normalizeRating(control) * 0.35)
}

export function disciplineHintThreshold(discipline: number): number {
  return clamp(0.82 - normalizeRating(discipline) * 0.08, 0.74, 0.9)
}

export function transitionAfterThirdOut(
  inning: number,
  half: Half,
  score: Score,
): InningTransition {
  if (half === 'top') {
    if (inning >= 3 && score.player > score.cpu) {
      return {
        kind: 'gameOver',
        inning,
        half,
        winner: 'player',
      }
    }
    return { kind: 'changeHalf', inning, half: 'bottom', winner: null }
  }

  if (inning >= 4) {
    const winner = score.player === score.cpu ? 'draw' : score.player > score.cpu ? 'player' : 'cpu'
    return { kind: 'gameOver', inning, half, winner }
  }

  if (inning >= 3 && score.player !== score.cpu) {
    return {
      kind: 'gameOver',
      inning,
      half,
      winner: score.player > score.cpu ? 'player' : 'cpu',
    }
  }

  return { kind: 'changeHalf', inning: inning + 1, half: 'top', winner: null }
}

export function isWalkOff(inning: number, half: Half, score: Score): boolean {
  return inning >= 3 && half === 'bottom' && score.player > score.cpu
}

export function isInsideStrikeZone(x: number, y: number): boolean {
  return Math.abs(x) <= 1 && Math.abs(y) <= 1
}

export const cpuProfiles: Record<Difficulty, CpuProfile> = {
  easy: {
    strikeSwingChance: 0.64,
    chaseChance: 0.1,
    timingSpread: 0.22,
    aimSpread: 0.72,
    pitchSpeedMultiplier: 0.9,
  },
  normal: {
    strikeSwingChance: 0.76,
    chaseChance: 0.18,
    timingSpread: 0.15,
    aimSpread: 0.5,
    pitchSpeedMultiplier: 1,
  },
  hard: {
    strikeSwingChance: 0.88,
    chaseChance: 0.28,
    timingSpread: 0.09,
    aimSpread: 0.3,
    pitchSpeedMultiplier: 1.12,
  },
}

export function createSeededRandom(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
