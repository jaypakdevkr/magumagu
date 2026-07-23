import { getRatedTeam } from './ratings'
import type {
  LineupSelection,
  MatchRoster,
  RatedHitter,
  RatedPitcher,
  RatedTeam,
  TeamId,
} from './types'

const byOverall = (a: RatedHitter, b: RatedHitter): number => b.ratings.overall - a.ratings.overall

export function recommendHitters(team: RatedTeam): RatedHitter[] {
  const catchers = team.hitters.filter((player) => player.positionGroup === 'catcher').sort(byOverall)
  const infielders = team.hitters.filter((player) => player.positionGroup === 'infielder').sort(byOverall)
  const outfielders = team.hitters.filter((player) => player.positionGroup === 'outfielder').sort(byOverall)
  const selected = [...catchers.slice(0, 1), ...infielders.slice(0, 4), ...outfielders.slice(0, 3)]
  const selectedIds = new Set(selected.map((player) => player.id))
  const designatedHitter = team.hitters.filter((player) => !selectedIds.has(player.id)).sort(byOverall)[0]
  if (designatedHitter) selected.push(designatedHitter)
  if (selected.length !== 9) throw new Error(`${team.name}의 추천 라인업을 구성할 수 없습니다.`)
  return orderRecommendedLineup(selected)
}

function battingScore(player: RatedHitter, slot: number): number {
  const { contact, power, discipline, speed, clutch, overall } = player.ratings
  if (slot === 0) return contact * 0.35 + discipline * 0.35 + speed * 0.3
  if (slot === 1) return contact * 0.45 + discipline * 0.35 + speed * 0.2
  if (slot === 2) return overall * 0.45 + contact * 0.3 + power * 0.25
  if (slot === 3) return power * 0.55 + clutch * 0.25 + contact * 0.2
  if (slot === 4) return power * 0.4 + clutch * 0.3 + overall * 0.3
  return overall * 0.72 + contact * 0.18 + speed * 0.1
}

export function orderRecommendedLineup(players: RatedHitter[]): RatedHitter[] {
  const remaining = [...players]
  const ordered: RatedHitter[] = []
  for (let slot = 0; slot < 9; slot += 1) {
    remaining.sort((a, b) => battingScore(b, slot) - battingScore(a, slot))
    const next = remaining.shift()
    if (!next) break
    ordered.push(next)
  }
  return ordered
}

export function recommendPitcher(team: RatedTeam): RatedPitcher {
  const pitcher = [...team.pitchers].sort(
    (a, b) =>
      b.ratings.overall * 0.7 + b.ratings.stamina * 0.3 -
      (a.ratings.overall * 0.7 + a.ratings.stamina * 0.3),
  )[0]
  if (!pitcher) throw new Error(`${team.name}에 선택 가능한 투수가 없습니다.`)
  return pitcher
}

export function recommendedSelection(teamId: TeamId): LineupSelection {
  const team = getRatedTeam(teamId)
  return {
    teamId,
    hitterIds: recommendHitters(team).map((player) => player.id),
    pitcherId: recommendPitcher(team).id,
  }
}

export function validateLineup(team: RatedTeam, selection: LineupSelection): string[] {
  const errors: string[] = []
  const uniqueIds = new Set(selection.hitterIds)
  const hitters = selection.hitterIds
    .map((id) => team.hitters.find((player) => player.id === id))
    .filter((player): player is RatedHitter => Boolean(player))
  if (selection.teamId !== team.id) errors.push('선택한 팀과 라인업 팀이 다릅니다.')
  if (selection.hitterIds.length !== 9) errors.push('타자는 정확히 9명을 선택해야 합니다.')
  if (uniqueIds.size !== selection.hitterIds.length) errors.push('같은 타자를 중복 선택할 수 없습니다.')
  if (hitters.length !== selection.hitterIds.length) errors.push('다른 팀 또는 존재하지 않는 타자가 포함됐습니다.')
  if (hitters.filter((player) => player.positionGroup === 'catcher').length < 1) {
    errors.push('포수를 1명 이상 선택해야 합니다.')
  }
  if (hitters.filter((player) => player.positionGroup === 'infielder').length < 4) {
    errors.push('내야수를 4명 이상 선택해야 합니다.')
  }
  if (hitters.filter((player) => player.positionGroup === 'outfielder').length < 3) {
    errors.push('외야수를 3명 이상 선택해야 합니다.')
  }
  if (!team.pitchers.some((player) => player.id === selection.pitcherId)) {
    errors.push('선발투수를 선택해야 합니다.')
  }
  return errors
}

export function buildMatchRoster(selection: LineupSelection): MatchRoster {
  const playerTeam = getRatedTeam(selection.teamId)
  const cpuTeamId: TeamId = selection.teamId === 'LG' ? 'HH' : 'LG'
  const cpuTeam = getRatedTeam(cpuTeamId)
  const errors = validateLineup(playerTeam, selection)
  if (errors.length > 0) throw new Error(errors.join('\n'))

  const playerLineup = selection.hitterIds.map((id) => {
    const player = playerTeam.hitters.find((candidate) => candidate.id === id)
    if (!player) throw new Error(`타자 ${id}를 찾을 수 없습니다.`)
    return player
  })
  const playerPitcher = playerTeam.pitchers.find((player) => player.id === selection.pitcherId)
  if (!playerPitcher) throw new Error(`투수 ${selection.pitcherId}를 찾을 수 없습니다.`)

  return {
    playerTeam,
    cpuTeam,
    playerLineup,
    cpuLineup: recommendHitters(cpuTeam),
    playerPitcher,
    cpuPitcher: recommendPitcher(cpuTeam),
  }
}
