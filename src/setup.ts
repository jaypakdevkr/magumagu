import { getRatedTeam, ratingScaleDescription, ratedTeams } from './ratings'
import { recommendedSelection, validateLineup } from './lineup'
import type {
  Difficulty,
  LineupSelection,
  RatedHitter,
  RatedPitcher,
  RatedPlayer,
  TeamId,
} from './types'

const difficultyLabels: Record<Difficulty, string> = {
  easy: '쉬움',
  normal: '보통',
  hard: '어려움',
}

const positionLabels = {
  catcher: '포수',
  infielder: '내야수',
  outfielder: '외야수',
  pitcher: '투수',
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')

const average = (value: number): string => value.toFixed(3).replace(/^0/, '')

function innings(value: number): string {
  const whole = Math.floor(value)
  const remainder = value - whole
  if (remainder > 0.6) return `${whole}⅔`
  if (remainder > 0.2) return `${whole}⅓`
  return String(whole)
}

export class SetupPanel {
  private readonly element: HTMLElement
  private currentTeamId: TeamId = 'LG'
  private currentDifficulty: Difficulty = 'normal'
  private selection: LineupSelection = recommendedSelection('LG')
  private detailPlayerId = this.selection.hitterIds[0]
  private onStart: ((selection: LineupSelection, difficulty: Difficulty) => void) | null = null
  private onClose: (() => void) | null = null
  private onPhaseChange: ((phase: 'teamSelect' | 'lineupSetup') => void) | null = null

  constructor(element: HTMLElement) {
    this.element = element
  }

  showTeamSelection(
    teamId: TeamId,
    difficulty: Difficulty,
    onStart: (selection: LineupSelection, difficulty: Difficulty) => void,
    onClose: () => void,
    onPhaseChange: (phase: 'teamSelect' | 'lineupSetup') => void,
  ): void {
    this.currentTeamId = teamId
    this.currentDifficulty = difficulty
    this.onStart = onStart
    this.onClose = onClose
    this.onPhaseChange = onPhaseChange
    this.element.hidden = false
    this.renderTeamSelection()
  }

  hide(): void {
    this.element.hidden = true
    this.element.replaceChildren()
  }

  private renderTeamSelection(): void {
    this.element.innerHTML = `
      <section class="setup-screen team-screen" aria-labelledby="teamSelectTitle">
        <div class="setup-heading">
          <div>
            <p class="setup-kicker">2026 KBO MATCH</p>
            <h2 id="teamSelectTitle">내 팀을 선택하세요</h2>
            <p>선택하지 않은 팀이 상대가 됩니다.</p>
          </div>
          <button type="button" class="setup-close" data-action="close" aria-label="타이틀로 돌아가기">×</button>
        </div>
        <div class="team-choice-grid">
          ${ratedTeams
            .map(
              (team) => `
                <button
                  type="button"
                  class="team-choice ${team.id === this.currentTeamId ? 'selected' : ''}"
                  data-action="select-team"
                  data-team="${team.id}"
                  style="--team-color:${team.primaryColor};--team-secondary:${team.secondaryColor}"
                  aria-pressed="${team.id === this.currentTeamId}"
                >
                  <span class="team-monogram">${team.id === 'LG' ? 'LG' : 'E'}</span>
                  <span class="team-choice-copy"><strong>${escapeHtml(team.name)}</strong><small>${team.hitters.length} 야수 · ${team.pitchers.length} 투수</small></span>
                  <span class="team-check">✓</span>
                </button>`,
            )
            .join('')}
        </div>
        <fieldset class="difficulty-fieldset">
          <legend>CPU 난이도</legend>
          <div class="difficulty-options">
            ${(['easy', 'normal', 'hard'] as Difficulty[])
              .map(
                (difficulty) => `
                  <button type="button" class="difficulty-option ${difficulty === this.currentDifficulty ? 'selected' : ''}" data-action="difficulty" data-difficulty="${difficulty}" aria-pressed="${difficulty === this.currentDifficulty}">
                    <strong>${difficultyLabels[difficulty]}</strong>
                    <span>${difficulty === 'easy' ? '여유로운 판단' : difficulty === 'normal' ? '균형 잡힌 승부' : '빠르고 정교한 CPU'}</span>
                  </button>`,
              )
              .join('')}
          </div>
        </fieldset>
        <div class="setup-source"><span>DATA</span> 2026.07.22 기준 KBO 1군 등록 선수와 누적 기록</div>
        <button type="button" class="setup-primary" data-action="lineup">라인업 편성하기 <span>→</span></button>
      </section>`

    this.element.onclick = (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]')
      if (!button) return
      const action = button.dataset.action
      if (action === 'close') this.onClose?.()
      if (action === 'select-team') {
        this.currentTeamId = button.dataset.team as TeamId
        this.renderTeamSelection()
      }
      if (action === 'difficulty') {
        this.currentDifficulty = button.dataset.difficulty as Difficulty
        this.renderTeamSelection()
      }
      if (action === 'lineup') {
        this.onPhaseChange?.('lineupSetup')
        this.selection = recommendedSelection(this.currentTeamId)
        this.detailPlayerId = this.selection.hitterIds[0]
        this.renderLineup()
      }
    }
  }

  private renderLineup(): void {
    const team = getRatedTeam(this.currentTeamId)
    const selectedIds = new Set(this.selection.hitterIds)
    const selected = this.selection.hitterIds
      .map((id) => team.hitters.find((player) => player.id === id))
      .filter((player): player is RatedHitter => Boolean(player))
    const available = team.hitters
      .filter((player) => !selectedIds.has(player.id))
      .sort((a, b) => b.ratings.overall - a.ratings.overall)
    const pitcher = team.pitchers.find((player) => player.id === this.selection.pitcherId) ?? team.pitchers[0]
    const detailPlayer =
      team.players.find((player) => player.id === this.detailPlayerId) ?? selected[0] ?? pitcher
    const errors = validateLineup(team, this.selection)
    const counts = {
      catcher: selected.filter((player) => player.positionGroup === 'catcher').length,
      infielder: selected.filter((player) => player.positionGroup === 'infielder').length,
      outfielder: selected.filter((player) => player.positionGroup === 'outfielder').length,
    }

    this.element.innerHTML = `
      <section class="setup-screen lineup-screen" aria-labelledby="lineupTitle">
        <div class="lineup-topbar" style="--team-color:${team.primaryColor}">
          <button type="button" class="setup-back" data-action="back">← 팀 선택</button>
          <div><p class="setup-kicker">${escapeHtml(team.name)}</p><h2 id="lineupTitle">라인업 편성</h2></div>
          <button type="button" class="setup-secondary" data-action="recommend">추천 편성</button>
        </div>
        <div class="lineup-layout">
          <div class="roster-column">
            <div class="column-title"><strong>선수 명단</strong><span>${available.length}명 대기</span></div>
            <div class="roster-list">
              ${available.length === 0 ? '<p class="empty-roster">선택 가능한 야수가 없습니다.</p>' : available.map((player) => this.hitterRow(player, false)).join('')}
            </div>
          </div>
          <div class="selected-column">
            <div class="column-title"><strong>타순</strong><span>${selected.length}/9</span></div>
            <div class="position-requirements">
              <span class="${counts.catcher >= 1 ? 'valid' : ''}">포수 ${counts.catcher}/1</span>
              <span class="${counts.infielder >= 4 ? 'valid' : ''}">내야 ${counts.infielder}/4</span>
              <span class="${counts.outfielder >= 3 ? 'valid' : ''}">외야 ${counts.outfielder}/3</span>
            </div>
            <ol class="batting-order">
              ${selected.map((player, index) => this.selectedRow(player, index)).join('')}
              ${Array.from({ length: Math.max(0, 9 - selected.length) }, (_, index) => `<li class="empty-slot"><span>${selected.length + index + 1}</span>선수를 추가하세요</li>`).join('')}
            </ol>
          </div>
          <aside class="detail-column">
            ${this.playerDetail(detailPlayer)}
            <div class="pitcher-select">
              <div class="column-title"><strong>선발투수</strong><span>${team.pitchers.length}명</span></div>
              <div class="pitcher-options">
                ${[...team.pitchers]
                  .sort((a, b) => b.ratings.overall - a.ratings.overall)
                  .map((candidate) => this.pitcherOption(candidate, candidate.id === pitcher.id))
                  .join('')}
              </div>
            </div>
          </aside>
        </div>
        <div class="lineup-footer">
          <div class="lineup-validation ${errors.length === 0 ? 'valid' : ''}">
            ${errors.length === 0 ? '✓ 경기 준비 완료' : escapeHtml(errors[0])}
          </div>
          <div class="rating-note">${escapeHtml(ratingScaleDescription)}</div>
          <button type="button" class="setup-primary compact" data-action="start" ${errors.length > 0 ? 'disabled' : ''}>경기 시작 <span>→</span></button>
        </div>
      </section>`

    this.element.onclick = (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]')
      if (!button) return
      const action = button.dataset.action
      const playerId = button.dataset.player
      if (action === 'back') {
        this.onPhaseChange?.('teamSelect')
        this.renderTeamSelection()
      }
      if (action === 'recommend') {
        this.selection = recommendedSelection(this.currentTeamId)
        this.detailPlayerId = this.selection.hitterIds[0]
        this.renderLineup()
      }
      if (action === 'detail' && playerId) {
        this.detailPlayerId = playerId
        this.renderLineup()
      }
      if (action === 'add' && playerId && this.selection.hitterIds.length < 9) {
        this.selection.hitterIds.push(playerId)
        this.detailPlayerId = playerId
        this.renderLineup()
      }
      if (action === 'remove' && playerId) {
        this.selection.hitterIds = this.selection.hitterIds.filter((id) => id !== playerId)
        this.renderLineup()
      }
      if ((action === 'up' || action === 'down') && playerId) {
        const index = this.selection.hitterIds.indexOf(playerId)
        const destination = action === 'up' ? index - 1 : index + 1
        if (index >= 0 && destination >= 0 && destination < this.selection.hitterIds.length) {
          ;[this.selection.hitterIds[index], this.selection.hitterIds[destination]] = [
            this.selection.hitterIds[destination],
            this.selection.hitterIds[index],
          ]
          this.renderLineup()
        }
      }
      if (action === 'pitcher' && playerId) {
        this.selection.pitcherId = playerId
        this.detailPlayerId = playerId
        this.renderLineup()
      }
      if (action === 'start' && errors.length === 0) {
        this.onStart?.(
          { ...this.selection, hitterIds: [...this.selection.hitterIds] },
          this.currentDifficulty,
        )
      }
    }
  }

  private hitterRow(player: RatedHitter, selected: boolean): string {
    return `
      <div class="roster-row ${selected ? 'selected' : ''}">
        <button type="button" class="player-identity" data-action="detail" data-player="${player.id}">
          <span class="player-number">${escapeHtml(player.number)}</span>
          <span><strong>${escapeHtml(player.name)}</strong><small>${positionLabels[player.positionGroup]} · AVG ${average(player.stats.battingAverage)} · OPS ${player.stats.ops.toFixed(3)}</small></span>
        </button>
        <span class="overall-badge">${player.ratings.overall}</span>
        <button type="button" class="row-action" data-action="add" data-player="${player.id}" aria-label="${escapeHtml(player.name)} 타순에 추가">+</button>
      </div>`
  }

  private selectedRow(player: RatedHitter, index: number): string {
    return `
      <li class="selected-row">
        <span class="order-number">${index + 1}</span>
        <button type="button" class="selected-player" data-action="detail" data-player="${player.id}"><strong>${escapeHtml(player.name)}</strong><small>${positionLabels[player.positionGroup]} · OVR ${player.ratings.overall}</small></button>
        <div class="order-actions">
          <button type="button" data-action="up" data-player="${player.id}" ${index === 0 ? 'disabled' : ''} aria-label="위로">↑</button>
          <button type="button" data-action="down" data-player="${player.id}" ${index === 8 ? 'disabled' : ''} aria-label="아래로">↓</button>
          <button type="button" data-action="remove" data-player="${player.id}" aria-label="제외">×</button>
        </div>
      </li>`
  }

  private pitcherOption(player: RatedPitcher, selected: boolean): string {
    return `
      <button type="button" class="pitcher-option ${selected ? 'selected' : ''}" data-action="pitcher" data-player="${player.id}" aria-pressed="${selected}">
        <span class="player-number">${escapeHtml(player.number)}</span>
        <span><strong>${escapeHtml(player.name)}</strong><small>ERA ${player.stats.earnedRunAverage.toFixed(2)} · WHIP ${player.stats.whip.toFixed(2)} · ${innings(player.stats.inningsPitched)} IP</small></span>
        <span class="overall-badge">${player.ratings.overall}</span>
      </button>`
  }

  private playerDetail(player: RatedPlayer): string {
    const isHitter = player.kind === 'hitter'
    const ratings = isHitter
      ? [
          ['컨택', player.ratings.contact],
          ['파워', player.ratings.power],
          ['선구', player.ratings.discipline],
          ['주루', player.ratings.speed],
          ['클러치', player.ratings.clutch],
        ]
      : [
          ['구위', player.ratings.stuff],
          ['제구', player.ratings.control],
          ['체력', player.ratings.stamina],
          ['위기관리', player.ratings.prevention],
        ]
    const statline = isHitter
      ? `AVG ${average(player.stats.battingAverage)} · OPS ${player.stats.ops.toFixed(3)} · HR ${player.stats.homeRuns} · SB ${player.stats.stolenBases}`
      : `ERA ${player.stats.earnedRunAverage.toFixed(2)} · WHIP ${player.stats.whip.toFixed(2)} · SO ${player.stats.strikeouts} · IP ${innings(player.stats.inningsPitched)}`
    const rawRecords = isHitter
      ? `G ${player.stats.games} · PA ${player.stats.plateAppearances} · AB ${player.stats.atBats} · H ${player.stats.hits} · 2B ${player.stats.doubles} · 3B ${player.stats.triples} · HR ${player.stats.homeRuns} · RBI ${player.stats.runsBattedIn} · SB ${player.stats.stolenBases} · CS ${player.stats.caughtStealing} · BB ${player.stats.walks} · SO ${player.stats.strikeouts} · AVG ${average(player.stats.battingAverage)} · SLG ${average(player.stats.slugging)} · OBP ${average(player.stats.onBasePercentage)} · OPS ${player.stats.ops.toFixed(3)} · E ${player.stats.errors} · RISP ${player.stats.runnersInScoringPositionAverage === null ? '-' : average(player.stats.runnersInScoringPositionAverage)}`
      : `G ${player.stats.games} · TBF ${player.stats.battersFaced} · IP ${innings(player.stats.inningsPitched)} · H ${player.stats.hitsAllowed} · HR ${player.stats.homeRunsAllowed} · BB ${player.stats.walksAllowed} · SO ${player.stats.strikeouts} · ER ${player.stats.earnedRuns} · ERA ${player.stats.earnedRunAverage.toFixed(2)} · WHIP ${player.stats.whip.toFixed(2)} · AVG ${average(player.stats.opponentBattingAverage)} · QS ${player.stats.qualityStarts}`
    const formula = isHitter
      ? '컨택=AVG 65%+역K% 35% · 파워=ISO 65%+HR/PA 35% · 선구=OBP 55%+BB/PA 45% · 주루=SB/G 45%+SB% 35%+3B/PA 20% · 클러치=RISP 60%+RBI/PA 40%'
      : '구위=K/9 60%+역피안타율 40% · 제구=역BB/9 65%+역WHIP 35% · 체력=IP/G 60%+QS/G 40% · 위기관리=역ERA 55%+역WHIP 45%'
    return `
      <article class="player-detail-card">
        <div class="detail-head">
          <span class="detail-number">${escapeHtml(player.number)}</span>
          <div><small>${positionLabels[player.positionGroup]} · ${escapeHtml(player.batsThrows)}</small><h3>${escapeHtml(player.name)}</h3></div>
          <span class="detail-overall"><small>OVR</small>${player.ratings.overall}</span>
        </div>
        <p class="detail-statline">${statline}</p>
        <div class="rating-list">
          ${ratings
            .map(
              ([label, rating]) => `
                <div class="rating-row"><span>${label}</span><div><i style="width:${Number(rating)}%"></i></div><strong>${rating}</strong></div>`,
            )
            .join('')}
        </div>
        <details class="rating-method">
          <summary>원기록 · 능력치 산식</summary>
          <p><strong>2026 원기록</strong>${rawRecords}</p>
          <p><strong>산식</strong>${formula}</p>
          <p><strong>보정</strong>LG·한화 선수 풀 백분위 45~95, 평균 70 · ${isHitter ? 'PA/(PA+60)' : 'TBF/(TBF+80)'} 표본 축소</p>
        </details>
        <a href="${player.sourceUrl}" target="_blank" rel="noreferrer">KBO 원기록 보기 ↗</a>
      </article>`
  }
}
