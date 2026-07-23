import snapshotJson from './data/kbo-2026-07-22.json'
import type {
  HitterRatings,
  HitterStats2026,
  KboDataSnapshot,
  KboHitter,
  KboPitcher,
  PitcherRatings,
  PitcherStats2026,
  RatedHitter,
  RatedPitcher,
  RatedTeam,
} from './types'

const snapshot = snapshotJson as KboDataSnapshot

const hitterStatKeys: Array<keyof HitterStats2026> = [
  'games',
  'plateAppearances',
  'atBats',
  'hits',
  'doubles',
  'triples',
  'homeRuns',
  'runsBattedIn',
  'stolenBases',
  'caughtStealing',
  'walks',
  'strikeouts',
  'battingAverage',
  'slugging',
  'onBasePercentage',
  'ops',
  'errors',
  'runnersInScoringPositionAverage',
]

const pitcherStatKeys: Array<keyof PitcherStats2026> = [
  'games',
  'battersFaced',
  'inningsPitched',
  'hitsAllowed',
  'homeRunsAllowed',
  'walksAllowed',
  'strikeouts',
  'earnedRuns',
  'earnedRunAverage',
  'whip',
  'opponentBattingAverage',
  'qualityStarts',
]

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value))

const safeRate = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null

function median(values: Array<number | null>): number {
  const sorted = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function fillMissing(values: Array<number | null>): number[] {
  const fallback = median(values)
  return values.map((value) => (value === null || !Number.isFinite(value) ? fallback : value))
}

function percentile(value: number, pool: number[], inverse = false): number {
  if (pool.length <= 1) return 0.5
  const lower = pool.filter((candidate) => candidate < value).length
  const equal = pool.filter((candidate) => candidate === value).length
  const rank = lower + Math.max(0, equal - 1) / 2
  const result = rank / (pool.length - 1)
  return inverse ? 1 - result : result
}

function shrinkPercentile(composite: number, sample: number, pseudoSample: number): number {
  const raw = 45 + 50 * clamp(composite, 0, 1)
  const reliability = sample <= 0 ? 0 : sample / (sample + pseudoSample)
  return Math.round(clamp(70 + (raw - 70) * reliability, 45, 95))
}

interface HitterMetricRow {
  player: KboHitter
  avg: number | null
  strikeoutRate: number | null
  isolatedPower: number | null
  homeRunRate: number | null
  obp: number | null
  walkRate: number | null
  stealsPerGame: number | null
  stealSuccess: number | null
  tripleRate: number | null
  risp: number | null
  rbiRate: number | null
}

function rateHitters(players: KboHitter[]): RatedHitter[] {
  const rows: HitterMetricRow[] = players.map((player) => {
    const stats = player.stats
    const attempts = stats.stolenBases + stats.caughtStealing
    return {
      player,
      avg: stats.atBats > 0 ? stats.battingAverage : null,
      strikeoutRate: safeRate(stats.strikeouts, stats.plateAppearances),
      isolatedPower: stats.atBats > 0 ? Math.max(0, stats.slugging - stats.battingAverage) : null,
      homeRunRate: safeRate(stats.homeRuns, stats.plateAppearances),
      obp: stats.plateAppearances > 0 ? stats.onBasePercentage : null,
      walkRate: safeRate(stats.walks, stats.plateAppearances),
      stealsPerGame: safeRate(stats.stolenBases, stats.games),
      stealSuccess: safeRate(stats.stolenBases, attempts),
      tripleRate: safeRate(stats.triples, stats.plateAppearances),
      risp: stats.runnersInScoringPositionAverage,
      rbiRate: safeRate(stats.runsBattedIn, stats.plateAppearances),
    }
  })

  const pools = {
    avg: fillMissing(rows.map((row) => row.avg)),
    strikeoutRate: fillMissing(rows.map((row) => row.strikeoutRate)),
    isolatedPower: fillMissing(rows.map((row) => row.isolatedPower)),
    homeRunRate: fillMissing(rows.map((row) => row.homeRunRate)),
    obp: fillMissing(rows.map((row) => row.obp)),
    walkRate: fillMissing(rows.map((row) => row.walkRate)),
    stealsPerGame: fillMissing(rows.map((row) => row.stealsPerGame)),
    stealSuccess: fillMissing(rows.map((row) => row.stealSuccess)),
    tripleRate: fillMissing(rows.map((row) => row.tripleRate)),
    risp: fillMissing(rows.map((row) => row.risp)),
    rbiRate: fillMissing(rows.map((row) => row.rbiRate)),
  }

  return rows.map((row, index) => {
    const sample = row.player.stats.plateAppearances
    const contact = shrinkPercentile(
      percentile(pools.avg[index], pools.avg) * 0.65 +
        percentile(pools.strikeoutRate[index], pools.strikeoutRate, true) * 0.35,
      sample,
      60,
    )
    const power = shrinkPercentile(
      percentile(pools.isolatedPower[index], pools.isolatedPower) * 0.65 +
        percentile(pools.homeRunRate[index], pools.homeRunRate) * 0.35,
      sample,
      60,
    )
    const discipline = shrinkPercentile(
      percentile(pools.obp[index], pools.obp) * 0.55 +
        percentile(pools.walkRate[index], pools.walkRate) * 0.45,
      sample,
      60,
    )
    const speed = shrinkPercentile(
      percentile(pools.stealsPerGame[index], pools.stealsPerGame) * 0.45 +
        percentile(pools.stealSuccess[index], pools.stealSuccess) * 0.35 +
        percentile(pools.tripleRate[index], pools.tripleRate) * 0.2,
      sample,
      60,
    )
    const clutch = shrinkPercentile(
      percentile(pools.risp[index], pools.risp) * 0.6 +
        percentile(pools.rbiRate[index], pools.rbiRate) * 0.4,
      sample,
      60,
    )
    const ratings: HitterRatings = {
      contact,
      power,
      discipline,
      speed,
      clutch,
      overall: Math.round(
        contact * 0.3 + power * 0.27 + discipline * 0.18 + speed * 0.12 + clutch * 0.13,
      ),
    }
    return { ...row.player, ratings }
  })
}

interface PitcherMetricRow {
  player: KboPitcher
  strikeoutsPerNine: number | null
  opponentAverage: number | null
  walksPerNine: number | null
  whip: number | null
  inningsPerGame: number | null
  qualityStartRate: number | null
  era: number | null
}

function ratePitchers(players: KboPitcher[]): RatedPitcher[] {
  const rows: PitcherMetricRow[] = players.map((player) => {
    const stats = player.stats
    return {
      player,
      strikeoutsPerNine: safeRate(stats.strikeouts * 9, stats.inningsPitched),
      opponentAverage: stats.battersFaced > 0 ? stats.opponentBattingAverage : null,
      walksPerNine: safeRate(stats.walksAllowed * 9, stats.inningsPitched),
      whip: stats.battersFaced > 0 ? stats.whip : null,
      inningsPerGame: safeRate(stats.inningsPitched, stats.games),
      qualityStartRate: safeRate(stats.qualityStarts, stats.games),
      era: stats.battersFaced > 0 ? stats.earnedRunAverage : null,
    }
  })
  const pools = {
    strikeoutsPerNine: fillMissing(rows.map((row) => row.strikeoutsPerNine)),
    opponentAverage: fillMissing(rows.map((row) => row.opponentAverage)),
    walksPerNine: fillMissing(rows.map((row) => row.walksPerNine)),
    whip: fillMissing(rows.map((row) => row.whip)),
    inningsPerGame: fillMissing(rows.map((row) => row.inningsPerGame)),
    qualityStartRate: fillMissing(rows.map((row) => row.qualityStartRate)),
    era: fillMissing(rows.map((row) => row.era)),
  }

  return rows.map((row, index) => {
    const sample = row.player.stats.battersFaced
    const stuff = shrinkPercentile(
      percentile(pools.strikeoutsPerNine[index], pools.strikeoutsPerNine) * 0.6 +
        percentile(pools.opponentAverage[index], pools.opponentAverage, true) * 0.4,
      sample,
      80,
    )
    const control = shrinkPercentile(
      percentile(pools.walksPerNine[index], pools.walksPerNine, true) * 0.65 +
        percentile(pools.whip[index], pools.whip, true) * 0.35,
      sample,
      80,
    )
    const stamina = shrinkPercentile(
      percentile(pools.inningsPerGame[index], pools.inningsPerGame) * 0.6 +
        percentile(pools.qualityStartRate[index], pools.qualityStartRate) * 0.4,
      sample,
      80,
    )
    const prevention = shrinkPercentile(
      percentile(pools.era[index], pools.era, true) * 0.55 +
        percentile(pools.whip[index], pools.whip, true) * 0.45,
      sample,
      80,
    )
    const ratings: PitcherRatings = {
      stuff,
      control,
      stamina,
      prevention,
      overall: Math.round(stuff * 0.3 + control * 0.28 + stamina * 0.18 + prevention * 0.24),
    }
    return { ...row.player, ratings }
  })
}

export function validateSnapshot(data: KboDataSnapshot): string[] {
  const errors: string[] = []
  const players = data.teams.flatMap((team) => team.players)
  if (data.meta.season !== 2026) errors.push('시즌은 2026이어야 합니다.')
  if (data.meta.snapshotDate !== '2026-07-22') errors.push('스냅샷 기준일이 다릅니다.')
  if (data.teams.length !== 2) errors.push('팀은 LG와 한화 두 팀이어야 합니다.')
  data.teams.forEach((team) => {
    if (team.players.length !== 30) errors.push(`${team.name} 선수 수가 30명이 아닙니다.`)
  })
  const uniqueIds = new Set(players.map((player) => player.id))
  if (uniqueIds.size !== players.length) errors.push('중복 선수 ID가 있습니다.')
  players.forEach((player) => {
    if (!player.id || !player.name || !player.sourceUrl) errors.push('필수 선수 정보가 누락됐습니다.')
    const runtimePosition = player.positionGroup as string
    if (player.kind === 'pitcher' && runtimePosition !== 'pitcher') {
      errors.push(`${String(player.name)}의 투수 포지션이 잘못됐습니다.`)
    }
    if (player.kind === 'hitter' && runtimePosition === 'pitcher') {
      errors.push(`${String(player.name)}의 야수 포지션이 잘못됐습니다.`)
    }
    if (
      player.kind === 'hitter' &&
      !['catcher', 'infielder', 'outfielder'].includes(runtimePosition)
    ) {
      errors.push(`${String(player.name)}의 야수 포지션군이 유효하지 않습니다.`)
    }

    const stats = player.stats as unknown as Record<string, unknown>
    const requiredKeys = player.kind === 'hitter' ? hitterStatKeys : pitcherStatKeys
    requiredKeys.forEach((key) => {
      const value = stats[key]
      const nullableRisp = player.kind === 'hitter' && key === 'runnersInScoringPositionAverage'
      if (value === undefined || (!nullableRisp && (typeof value !== 'number' || !Number.isFinite(value)))) {
        errors.push(`${String(player.name)}의 ${key} 기록이 누락됐습니다.`)
      }
      if (nullableRisp && value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        errors.push(`${String(player.name)}의 ${key} 기록이 잘못됐습니다.`)
      }
    })
  })
  return errors
}

export function buildRatedTeams(data: KboDataSnapshot): RatedTeam[] {
  const errors = validateSnapshot(data)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  const allHitters = data.teams.flatMap((team) =>
    team.players.filter((player): player is KboHitter => player.kind === 'hitter'),
  )
  const allPitchers = data.teams.flatMap((team) =>
    team.players.filter((player): player is KboPitcher => player.kind === 'pitcher'),
  )
  const ratedHitters = new Map(rateHitters(allHitters).map((player) => [player.id, player]))
  const ratedPitchers = new Map(ratePitchers(allPitchers).map((player) => [player.id, player]))

  return data.teams.map((team) => {
    const players = team.players.map((player) => {
      const rated = player.kind === 'hitter' ? ratedHitters.get(player.id) : ratedPitchers.get(player.id)
      if (!rated) throw new Error(`${player.name}의 능력치를 계산하지 못했습니다.`)
      return rated
    })
    return {
      ...team,
      players,
      hitters: players.filter((player): player is RatedHitter => player.kind === 'hitter'),
      pitchers: players.filter((player): player is RatedPitcher => player.kind === 'pitcher'),
    }
  })
}

export const kboSnapshot = snapshot
export const ratedTeams = buildRatedTeams(snapshot)

export const getRatedTeam = (teamId: 'LG' | 'HH'): RatedTeam => {
  const team = ratedTeams.find((candidate) => candidate.id === teamId)
  if (!team) throw new Error(`${teamId} 팀 데이터를 찾을 수 없습니다.`)
  return team
}

export const ratingScaleDescription =
  '45~95 · 평균 70 · 2026.07.22 KBO 기록 기반 · LG/한화 선수 내 상대평가'
