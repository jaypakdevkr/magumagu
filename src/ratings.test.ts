import { describe, expect, it } from 'vitest'
import { buildRatedTeams, kboSnapshot, ratedTeams, validateSnapshot } from './ratings'
import { buildMatchRoster, recommendedSelection, validateLineup } from './lineup'

describe('KBO snapshot', () => {
  it('contains the exact July 22 LG and Hanwha roster', () => {
    expect(validateSnapshot(kboSnapshot)).toEqual([])
    expect(kboSnapshot.teams.map((team) => [team.id, team.players.length])).toEqual([
      ['LG', 30],
      ['HH', 30],
    ])
    expect(kboSnapshot.teams.flatMap((team) => team.players)).toHaveLength(60)
  })

  it('has 31 hitters and 29 pitchers with unique IDs', () => {
    const players = kboSnapshot.teams.flatMap((team) => team.players)
    expect(players.filter((player) => player.kind === 'hitter')).toHaveLength(31)
    expect(players.filter((player) => player.kind === 'pitcher')).toHaveLength(29)
    expect(new Set(players.map((player) => player.id)).size).toBe(60)
  })

  it('produces bounded deterministic ratings', () => {
    const rerated = buildRatedTeams(kboSnapshot)
    expect(rerated).toEqual(ratedTeams)
    ratedTeams.flatMap((team) => team.players).forEach((player) => {
      Object.values(player.ratings).forEach((rating) => {
        expect(rating).toBeGreaterThanOrEqual(45)
        expect(rating).toBeLessThanOrEqual(95)
      })
    })
  })

  it('shrinks a five-PA outlier toward average', () => {
    const hanwha = ratedTeams.find((team) => team.id === 'HH')!
    const tinySample = hanwha.hitters.find((player) => player.name === '한지윤')!
    expect(tinySample.stats.ops).toBeGreaterThan(1.2)
    expect(tinySample.ratings.overall).toBeLessThan(75)
  })

  it('keeps missing RISP values valid and converts fractional innings', () => {
    const players = kboSnapshot.teams.flatMap((team) => team.players)
    const imChanGyu = players.find(
      (player) => player.kind === 'pitcher' && player.name === '임찬규',
    )
    const withMissingRisp = structuredClone(kboSnapshot)
    const hitter = withMissingRisp.teams
      .flatMap((team) => team.players)
      .find((player) => player.kind === 'hitter')
    if (hitter?.kind === 'hitter') hitter.stats.runnersInScoringPositionAverage = null
    expect(() => buildRatedTeams(withMissingRisp)).not.toThrow()
    expect(imChanGyu?.kind === 'pitcher' ? imChanGyu.stats.inningsPitched % 1 : 0).toBeCloseTo(1 / 3)
  })

  it('monotonically rewards stronger source hitting and pitching records', () => {
    const custom = structuredClone(kboSnapshot)
    const hitters = custom.teams.flatMap((team) =>
      team.players.filter((player) => player.kind === 'hitter'),
    )
    const pitchers = custom.teams.flatMap((team) =>
      team.players.filter((player) => player.kind === 'pitcher'),
    )
    const strongHitter = hitters[0]
    const weakHitter = hitters[1]
    strongHitter.stats = {
      ...strongHitter.stats,
      games: 100, plateAppearances: 400, atBats: 350, hits: 140, homeRuns: 35,
      strikeouts: 35, walks: 50, battingAverage: 0.4, slugging: 0.75,
      onBasePercentage: 0.48, ops: 1.23,
    }
    weakHitter.stats = {
      ...weakHitter.stats,
      games: 100, plateAppearances: 400, atBats: 350, hits: 53, homeRuns: 1,
      strikeouts: 150, walks: 8, battingAverage: 0.151, slugging: 0.19,
      onBasePercentage: 0.18, ops: 0.37,
    }
    const strongPitcher = pitchers[0]
    const weakPitcher = pitchers[1]
    strongPitcher.stats = {
      ...strongPitcher.stats,
      games: 20, battersFaced: 500, inningsPitched: 130, hitsAllowed: 80,
      walksAllowed: 18, strikeouts: 170, earnedRunAverage: 1.8, whip: 0.82,
      opponentBattingAverage: 0.18, qualityStarts: 17,
    }
    weakPitcher.stats = {
      ...weakPitcher.stats,
      games: 20, battersFaced: 500, inningsPitched: 80, hitsAllowed: 140,
      walksAllowed: 75, strikeouts: 40, earnedRunAverage: 7.2, whip: 2.1,
      opponentBattingAverage: 0.35, qualityStarts: 1,
    }

    const rated = buildRatedTeams(custom).flatMap((team) => team.players)
    const ratedStrongHitter = rated.find((player) => player.id === strongHitter.id)
    const ratedWeakHitter = rated.find((player) => player.id === weakHitter.id)
    const ratedStrongPitcher = rated.find((player) => player.id === strongPitcher.id)
    const ratedWeakPitcher = rated.find((player) => player.id === weakPitcher.id)
    expect(ratedStrongHitter?.kind === 'hitter' ? ratedStrongHitter.ratings.contact : 0).toBeGreaterThan(
      ratedWeakHitter?.kind === 'hitter' ? ratedWeakHitter.ratings.contact : 0,
    )
    expect(ratedStrongHitter?.kind === 'hitter' ? ratedStrongHitter.ratings.power : 0).toBeGreaterThan(
      ratedWeakHitter?.kind === 'hitter' ? ratedWeakHitter.ratings.power : 0,
    )
    expect(ratedStrongPitcher?.kind === 'pitcher' ? ratedStrongPitcher.ratings.stuff : 0).toBeGreaterThan(
      ratedWeakPitcher?.kind === 'pitcher' ? ratedWeakPitcher.ratings.stuff : 0,
    )
    expect(ratedStrongPitcher?.kind === 'pitcher' ? ratedStrongPitcher.ratings.control : 0).toBeGreaterThan(
      ratedWeakPitcher?.kind === 'pitcher' ? ratedWeakPitcher.ratings.control : 0,
    )
  })
})

describe('lineup construction', () => {
  it('builds valid recommended lineups for both teams', () => {
    ratedTeams.forEach((team) => {
      expect(validateLineup(team, recommendedSelection(team.id))).toEqual([])
    })
  })

  it('rejects duplicate and position-invalid selections', () => {
    const team = ratedTeams[0]
    const selection = recommendedSelection(team.id)
    selection.hitterIds = Array(9).fill(team.hitters[0].id)
    const errors = validateLineup(team, selection)
    expect(errors.some((error) => error.includes('중복'))).toBe(true)
    expect(errors.some((error) => error.includes('내야수'))).toBe(true)
  })

  it('builds the opponent roster automatically', () => {
    const roster = buildMatchRoster(recommendedSelection('LG'))
    expect(roster.playerTeam.id).toBe('LG')
    expect(roster.cpuTeam.id).toBe('HH')
    expect(roster.playerLineup).toHaveLength(9)
    expect(roster.cpuLineup).toHaveLength(9)
  })
})
