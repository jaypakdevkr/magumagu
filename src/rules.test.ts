import { describe, expect, it } from 'vitest'
import {
  advanceRunners,
  applyPitchCall,
  controlJitter,
  cpuProfiles,
  createSeededRandom,
  effectivePitcherRating,
  isWalkOff,
  pitcherFatiguePenalty,
  resolveContact,
  transitionAfterThirdOut,
  walkRunners,
} from './rules'
import type { RunnerSlot } from './types'

const runner = (name: string, speed = 70): RunnerSlot => ({ playerId: name, name, speed })

describe('pitch count', () => {
  it('records a strikeout on the third strike', () => {
    const result = applyPitchCall({ balls: 1, strikes: 2, outs: 1 }, 'strike')
    expect(result).toEqual({
      count: { balls: 0, strikes: 0, outs: 2 },
      result: 'strikeout',
    })
  })

  it('does not add a third strike on a two-strike foul', () => {
    const result = applyPitchCall({ balls: 0, strikes: 2, outs: 0 }, 'foul')
    expect(result.count.strikes).toBe(2)
  })

  it('resets the count after ball four', () => {
    expect(applyPitchCall({ balls: 3, strikes: 1, outs: 0 }, 'ball').result).toBe('walk')
  })
})

describe('runner advancement', () => {
  it('forces in a run on a bases-loaded walk while preserving identities', () => {
    const result = walkRunners(
      { first: runner('A'), second: runner('B'), third: runner('C') },
      runner('타자'),
    )
    expect(result.runs).toBe(1)
    expect(result.bases).toEqual({ first: runner('타자'), second: runner('A'), third: runner('B') })
  })

  it('scores all runners and the batter on a home run', () => {
    expect(
      advanceRunners({ first: runner('A'), second: null, third: runner('C') }, 4, runner('타자')),
    ).toEqual({ bases: { first: null, second: null, third: null }, runs: 3 })
  })

  it('uses speed for taking an extra base on a single', () => {
    const fast = advanceRunners({ first: runner('빠름', 95), second: null, third: null }, 1, runner('타자'), () => 0.5)
    const slow = advanceRunners({ first: runner('느림', 45), second: null, third: null }, 1, runner('타자'), () => 0.5)
    expect(fast.bases.third?.name).toBe('빠름')
    expect(slow.bases.second?.name).toBe('느림')
  })
})

describe('innings and game ending', () => {
  it('skips the bottom of the third when the home player leads', () => {
    expect(transitionAfterThirdOut(3, 'top', { player: 2, cpu: 1 })).toMatchObject({
      kind: 'gameOver',
      winner: 'player',
    })
  })

  it('starts one extra inning after a tie in the third', () => {
    expect(transitionAfterThirdOut(3, 'bottom', { player: 2, cpu: 2 })).toEqual({
      kind: 'changeHalf', inning: 4, half: 'top', winner: null,
    })
  })

  it('declares a draw after a tied fourth inning', () => {
    expect(transitionAfterThirdOut(4, 'bottom', { player: 3, cpu: 3 })).toMatchObject({ winner: 'draw' })
  })

  it('recognizes a walk-off score', () => {
    expect(isWalkOff(3, 'bottom', { player: 4, cpu: 3 })).toBe(true)
  })
})

describe('ratings in gameplay', () => {
  it('rewards contact and power while strong pitching suppresses contact', () => {
    const eliteHitter = resolveContact(0.25, 0.82, 0.9, {
      contact: 95, power: 95, clutch: 70, pitcherStuff: 45, pitcherPrevention: 45, runnersInScoringPosition: false,
    })
    const weakHitter = resolveContact(0.25, 0.82, 0.9, {
      contact: 45, power: 45, clutch: 70, pitcherStuff: 95, pitcherPrevention: 95, runnersInScoringPosition: false,
    })
    expect(eliteHitter).not.toBe('miss')
    expect(weakHitter).toBe('miss')
  })

  it('applies stamina-driven fatigue after the sixth batter', () => {
    expect(pitcherFatiguePenalty(6, 45)).toBe(0)
    expect(pitcherFatiguePenalty(12, 45)).toBeGreaterThan(pitcherFatiguePenalty(12, 95))
    expect(effectivePitcherRating(80, 45, 20)).toBeGreaterThanOrEqual(68)
  })

  it('gives higher control ratings less target jitter', () => {
    expect(controlJitter(95)).toBeLessThan(controlJitter(45))
  })

  it('keeps difficulty profiles separate from ratings', () => {
    expect(cpuProfiles.hard.timingSpread).toBeLessThan(cpuProfiles.easy.timingSpread)
  })

  it('provides repeatable randomness', () => {
    const first = createSeededRandom(42)
    const second = createSeededRandom(42)
    expect([first(), first(), first()]).toEqual([second(), second(), second()])
  })
})
