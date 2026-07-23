import { GameAudio } from './audio'
import { buildMatchRoster, recommendedSelection } from './lineup'
import {
  advanceRunners,
  applyPitchCall,
  controlJitter,
  cpuProfiles,
  disciplineHintThreshold,
  effectivePitcherRating,
  emptyBases,
  emptyCount,
  isInsideStrikeZone,
  isWalkOff,
  normalizeRating,
  pitcherBreakMultiplier,
  pitcherSpeedMultiplier,
  recordOut,
  resolveContact,
  transitionAfterThirdOut,
  walkRunners,
} from './rules'
import { SetupPanel } from './setup'
import type {
  ContactResult,
  Difficulty,
  GamePhase,
  GameState,
  LineupSelection,
  PitchType,
  PlayResult,
  RatedHitter,
  RatedPitcher,
  RunnerSlot,
  Vec2,
  Winner,
} from './types'

const WIDTH = 960
const HEIGHT = 540
const ZONE_CENTER = { x: 480, y: 390 }
const ZONE_SCALE = { x: 60, y: 68 }

const pitchLabels: Record<PitchType, string> = {
  fastball: '직구',
  curve: '커브',
  changeup: '체인지업',
}

const resultLabels: Record<PlayResult, string> = {
  miss: '헛스윙!',
  foul: '파울!',
  out: '아웃!',
  single: '1루타!',
  double: '2루타!',
  triple: '3루타!',
  homeRun: '홈런!',
  ball: '볼!',
  calledStrike: '스트라이크!',
  walk: '볼넷!',
  strikeout: '삼진 아웃!',
}

interface ActivePitch {
  mode: 'playerBatting' | 'playerPitching'
  type: PitchType
  target: Vec2
  duration: number
  startedAt: number
  curveDirection: number
  userSwingAt: number | null
  userSwingAim: Vec2 | null
  cpuWillSwing: boolean
  cpuSwingAt: number
  cpuTimingError: number
  cpuAimError: number
  cpuSwung: boolean
}

interface LastPlay {
  result: PlayResult
  startedAt: number
  runs: number
  battingTeam: 'player' | 'cpu'
  batter: RatedHitter
}

export class BaseballGame {
  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D
  private readonly statusText: HTMLElement
  private readonly controlHint: HTMLElement
  private readonly muteButton: HTMLButtonElement
  private readonly audio = new GameAudio()
  private readonly setupPanel: SetupPanel
  private state: GameState
  private aim: Vec2 = { x: 0, y: 0 }
  private batCursor: Vec2 = { x: 0, y: 0 }
  private activePitch: ActivePitch | null = null
  private lastPlay: LastPlay | null = null
  private phaseStartedAt = 0
  private nextPitchAt = 0
  private pausedPhase: GamePhase = 'title'
  private pausedAt = 0
  private shake = 0
  private pendingBatterAdvance = false
  private configuredSelection: LineupSelection = recommendedSelection('LG')

  constructor(
    canvas: HTMLCanvasElement,
    statusText: HTMLElement,
    controlHint: HTMLElement,
    muteButton: HTMLButtonElement,
    setupOverlay: HTMLElement,
  ) {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D context를 사용할 수 없습니다.')

    this.canvas = canvas
    this.context = context
    this.statusText = statusText
    this.controlHint = controlHint
    this.muteButton = muteButton
    this.setupPanel = new SetupPanel(setupOverlay)
    this.state = this.createInitialState('normal', false)

    this.bindEvents()
    this.resizeCanvas()
    this.syncDom()
    requestAnimationFrame((time) => this.frame(time))
  }

  private createInitialState(difficulty: Difficulty, muted: boolean): GameState {
    return {
      phase: 'title',
      inning: 1,
      half: 'top',
      count: emptyCount(),
      bases: emptyBases(),
      score: { player: 0, cpu: 0 },
      difficulty,
      selectedPitch: 'fastball',
      lastResult: null,
      message: '난이도를 선택하고 경기를 시작하세요',
      muted,
      winner: null,
      selectedTeamId: 'LG',
      matchRoster: null,
      playerBattingIndex: 0,
      cpuBattingIndex: 0,
      playerPitcherBattersFaced: 0,
      cpuPitcherBattersFaced: 0,
    }
  }

  private bindEvents(): void {
    window.addEventListener('resize', () => this.resizeCanvas())
    window.addEventListener('keydown', (event) => this.handleKeyDown(event))
    this.canvas.addEventListener('pointerdown', (event) => this.handlePointer(event))
    this.muteButton.addEventListener('click', () => {
      void this.audio.unlock()
      this.toggleMute()
      this.canvas.focus()
    })
  }

  private resizeCanvas(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    this.canvas.width = WIDTH * ratio
    this.canvas.height = HEIGHT * ratio
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0)
  }

  private frame(time: number): void {
    this.update(time)
    this.render(time)
    requestAnimationFrame((nextTime) => this.frame(nextTime))
  }

  private update(time: number): void {
    if (
      this.state.phase === 'paused' ||
      this.state.phase === 'title' ||
      this.state.phase === 'teamSelect' ||
      this.state.phase === 'lineupSetup' ||
      this.state.phase === 'gameOver'
    ) {
      return
    }

    if (this.shake > 0) this.shake = Math.max(0, this.shake - 0.45)

    if (this.state.phase === 'halfIntro' && time - this.phaseStartedAt > 1350) {
      this.enterAtBat(time)
      return
    }

    if (this.state.phase === 'batting' && !this.activePitch && time >= this.nextPitchAt) {
      this.startCpuPitch(time)
      return
    }

    if (this.state.phase === 'pitchInFlight' && this.activePitch) {
      const elapsed = (time - this.activePitch.startedAt) / 1000
      if (
        this.activePitch.mode === 'playerPitching' &&
        this.activePitch.cpuWillSwing &&
        !this.activePitch.cpuSwung &&
        elapsed >= this.activePitch.cpuSwingAt
      ) {
        this.activePitch.cpuSwung = true
        this.audio.play('swing')
      }
      if (elapsed >= this.activePitch.duration) this.finishPitch(time)
      return
    }

    if (this.state.phase === 'result' && time - this.phaseStartedAt > 1150) {
      this.finishPlay(time)
      return
    }

    if (this.state.phase === 'ballInPlay' && time - this.phaseStartedAt > 1750) {
      this.finishPlay(time)
    }
  }

  private openTeamSelection(): void {
    this.state.phase = 'teamSelect'
    this.setupPanel.showTeamSelection(
      this.state.selectedTeamId,
      this.state.difficulty,
      (selection, difficulty) => this.startGame(selection, difficulty),
      () => {
        this.setupPanel.hide()
        this.state.phase = 'title'
        this.syncDom()
        this.canvas.focus()
      },
      (phase) => {
        this.state.phase = phase
        this.syncDom()
      },
    )
    this.audio.play('select')
    this.syncDom()
  }

  private startGame(
    selection: LineupSelection = this.configuredSelection,
    difficulty: Difficulty = this.state.difficulty,
  ): void {
    const muted = this.state.muted
    const roster = buildMatchRoster(selection)
    this.configuredSelection = { ...selection, hitterIds: [...selection.hitterIds] }
    this.state = this.createInitialState(difficulty, muted)
    this.state.selectedTeamId = selection.teamId
    this.state.matchRoster = roster
    this.state.phase = 'halfIntro'
    this.state.message = '1회 초 · 수비부터 시작합니다'
    this.phaseStartedAt = performance.now()
    this.activePitch = null
    this.lastPlay = null
    this.pendingBatterAdvance = false
    this.aim = { x: 0, y: 0 }
    this.batCursor = { x: 0, y: 0 }
    this.setupPanel.hide()
    this.audio.play('select')
    this.syncDom()
  }

  private getCurrentBatter(): RatedHitter {
    const roster = this.state.matchRoster
    if (!roster) throw new Error('경기 라인업이 준비되지 않았습니다.')
    return this.state.half === 'bottom'
      ? roster.playerLineup[this.state.playerBattingIndex % roster.playerLineup.length]
      : roster.cpuLineup[this.state.cpuBattingIndex % roster.cpuLineup.length]
  }

  private getCurrentPitcher(): RatedPitcher {
    const roster = this.state.matchRoster
    if (!roster) throw new Error('경기 투수가 준비되지 않았습니다.')
    return this.state.half === 'top' ? roster.playerPitcher : roster.cpuPitcher
  }

  private getPitcherBattersFaced(): number {
    return this.state.half === 'top'
      ? this.state.playerPitcherBattersFaced
      : this.state.cpuPitcherBattersFaced
  }

  private asRunner(player: RatedHitter): RunnerSlot {
    return { playerId: player.id, name: player.name, speed: player.ratings.speed }
  }

  private runnersInScoringPosition(): boolean {
    return Boolean(this.state.bases.second || this.state.bases.third)
  }

  private contactRatings() {
    const batter = this.getCurrentBatter()
    const pitcher = this.getCurrentPitcher()
    const faced = this.getPitcherBattersFaced()
    return {
      contact: batter.ratings.contact,
      power: batter.ratings.power,
      clutch: batter.ratings.clutch,
      pitcherStuff: effectivePitcherRating(
        pitcher.ratings.stuff,
        pitcher.ratings.stamina,
        faced,
      ),
      pitcherPrevention: pitcher.ratings.prevention,
      runnersInScoringPosition: this.runnersInScoringPosition(),
    }
  }

  private completePlateAppearance(): void {
    this.pendingBatterAdvance = true
  }

  private advanceBattingOrder(): void {
    if (!this.pendingBatterAdvance) return
    if (this.state.half === 'bottom') {
      this.state.playerBattingIndex = (this.state.playerBattingIndex + 1) % 9
      this.state.cpuPitcherBattersFaced += 1
    } else {
      this.state.cpuBattingIndex = (this.state.cpuBattingIndex + 1) % 9
      this.state.playerPitcherBattersFaced += 1
    }
    this.pendingBatterAdvance = false
  }

  private enterAtBat(time: number): void {
    this.activePitch = null
    this.lastPlay = null
    this.aim = { x: 0, y: 0 }
    this.batCursor = { x: 0, y: 0 }
    this.state.lastResult = null

    if (this.state.half === 'top') {
      this.state.phase = 'pitching'
      this.state.message = '코스를 조준하고 공을 던지세요'
    } else {
      this.state.phase = 'batting'
      this.state.message = '투수의 공을 기다리세요'
      this.nextPitchAt = time + 850
    }
    this.phaseStartedAt = time
    this.syncDom()
  }

  private startPlayerPitch(time: number): void {
    const type = this.state.selectedPitch
    const profile = cpuProfiles[this.state.difficulty]
    const pitcher = this.getCurrentPitcher()
    const batter = this.getCurrentBatter()
    const faced = this.getPitcherBattersFaced()
    const effectiveStuff = effectivePitcherRating(
      pitcher.ratings.stuff,
      pitcher.ratings.stamina,
      faced,
    )
    const effectiveControl = effectivePitcherRating(
      pitcher.ratings.control,
      pitcher.ratings.stamina,
      faced,
    )
    const jitter = controlJitter(effectiveControl)
    const target = {
      x: this.clamp(this.aim.x + this.randomBetween(-jitter, jitter), -1.45, 1.45),
      y: this.clamp(this.aim.y + this.randomBetween(-jitter, jitter), -1.45, 1.45),
    }
    const isStrike = isInsideStrikeZone(target.x, target.y)
    const discipline = normalizeRating(batter.ratings.discipline)
    const cpuSwingChance = isStrike
      ? this.clamp(profile.strikeSwingChance + normalizeRating(batter.ratings.contact) * 0.05, 0.45, 0.96)
      : this.clamp(profile.chaseChance - discipline * 0.12, 0.02, 0.55)
    const cpuWillSwing = Math.random() < cpuSwingChance
    const duration = this.pitchDuration(type, pitcherSpeedMultiplier(effectiveStuff))
    const contactTime = duration * 0.9
    const batterAccuracy = 1 - normalizeRating(batter.ratings.contact) * 0.15
    const timingError = Math.random() * profile.timingSpread * batterAccuracy

    this.activePitch = {
      mode: 'playerPitching',
      type,
      target,
      duration,
      startedAt: time,
      curveDirection: Math.random() > 0.5 ? 1 : -1,
      userSwingAt: null,
      userSwingAim: null,
      cpuWillSwing,
      cpuSwingAt: Math.max(0.1, contactTime - timingError),
      cpuTimingError: timingError,
      cpuAimError: Math.random() * profile.aimSpread * batterAccuracy,
      cpuSwung: false,
    }
    this.state.phase = 'pitchInFlight'
    this.state.message = `${pitchLabels[type]} 투구!`
    this.audio.play('pitch')
    this.syncDom()
  }

  private startCpuPitch(time: number): void {
    const profile = cpuProfiles[this.state.difficulty]
    const type = this.pickCpuPitch()
    const pitcher = this.getCurrentPitcher()
    const faced = this.getPitcherBattersFaced()
    const effectiveStuff = effectivePitcherRating(
      pitcher.ratings.stuff,
      pitcher.ratings.stamina,
      faced,
    )
    const effectiveControl = effectivePitcherRating(
      pitcher.ratings.control,
      pitcher.ratings.stamina,
      faced,
    )
    const strikeChance = this.state.difficulty === 'easy' ? 0.78 : this.state.difficulty === 'normal' ? 0.7 : 0.64
    const inZone = Math.random() < strikeChance
    let target: Vec2

    if (inZone) {
      target = {
        x: this.randomBetween(-0.88, 0.88),
        y: this.randomBetween(-0.88, 0.88),
      }
    } else {
      const side = Math.floor(Math.random() * 4)
      target = {
        x: side === 0 ? this.randomBetween(-1.35, -1.08) : side === 1 ? this.randomBetween(1.08, 1.35) : this.randomBetween(-1.1, 1.1),
        y: side === 2 ? this.randomBetween(-1.35, -1.08) : side === 3 ? this.randomBetween(1.08, 1.35) : this.randomBetween(-1.1, 1.1),
      }
    }

    const jitter = controlJitter(effectiveControl)
    target.x = this.clamp(target.x + this.randomBetween(-jitter, jitter), -1.45, 1.45)
    target.y = this.clamp(target.y + this.randomBetween(-jitter, jitter), -1.45, 1.45)

    this.activePitch = {
      mode: 'playerBatting',
      type,
      target,
      duration: this.pitchDuration(
        type,
        profile.pitchSpeedMultiplier * pitcherSpeedMultiplier(effectiveStuff),
      ),
      startedAt: time,
      curveDirection: Math.random() > 0.5 ? 1 : -1,
      userSwingAt: null,
      userSwingAim: null,
      cpuWillSwing: false,
      cpuSwingAt: 0,
      cpuTimingError: 0,
      cpuAimError: 0,
      cpuSwung: false,
    }
    this.state.phase = 'pitchInFlight'
    this.state.message = '공이 들어옵니다!'
    this.audio.play('pitch')
    this.syncDom()
  }

  private finishPitch(time: number): void {
    const pitch = this.activePitch
    if (!pitch) return

    if (pitch.mode === 'playerBatting') {
      if (pitch.userSwingAt !== null && pitch.userSwingAim) {
        const contactAt = pitch.duration * 0.9
        const timingError = Math.abs(pitch.userSwingAt - contactAt)
        const aimError = Math.hypot(
          pitch.userSwingAim.x - pitch.target.x,
          pitch.userSwingAim.y - pitch.target.y,
        )
        const result = resolveContact(timingError, aimError, Math.random(), this.contactRatings())
        this.processContact(result, time)
      } else {
        this.processPitchCall(isInsideStrikeZone(pitch.target.x, pitch.target.y) ? 'strike' : 'ball', time)
      }
    } else if (pitch.cpuWillSwing) {
      const result = resolveContact(
        pitch.cpuTimingError,
        pitch.cpuAimError,
        Math.random(),
        this.contactRatings(),
      )
      this.processContact(result, time)
    } else {
      this.processPitchCall(isInsideStrikeZone(pitch.target.x, pitch.target.y) ? 'strike' : 'ball', time)
    }
  }

  private processPitchCall(call: 'ball' | 'strike' | 'foul', time: number): void {
    const applied = applyPitchCall(this.state.count, call)
    this.state.count = applied.count
    this.activePitch = null

    if (applied.result === 'walk') {
      const advancement = walkRunners(this.state.bases, this.asRunner(this.getCurrentBatter()))
      this.state.bases = advancement.bases
      this.addRuns(advancement.runs)
      this.completePlateAppearance()
      this.showResult('walk', time, advancement.runs)
      return
    }

    if (applied.result === 'strikeout') {
      this.audio.play('out')
      this.completePlateAppearance()
      this.showResult('strikeout', time, 0)
      return
    }

    if (call === 'foul') {
      this.showResult('foul', time, 0)
    } else if (call === 'ball') {
      this.showResult('ball', time, 0)
    } else {
      this.showResult('calledStrike', time, 0)
    }
  }

  private processContact(result: ContactResult, time: number): void {
    this.activePitch = null
    if (result === 'miss') {
      this.processPitchCall('strike', time)
      return
    }
    if (result === 'foul') {
      this.processPitchCall('foul', time)
      return
    }

    if (result === 'out') {
      this.state.count = recordOut(this.state.count)
      this.audio.play('out')
      this.completePlateAppearance()
      this.showBallInPlay(result, time, 0)
      return
    }

    const hitBases = result === 'single' ? 1 : result === 'double' ? 2 : result === 'triple' ? 3 : 4
    const advancement = advanceRunners(
      this.state.bases,
      hitBases,
      this.asRunner(this.getCurrentBatter()),
    )
    this.state.bases = advancement.bases
    this.state.count = { balls: 0, strikes: 0, outs: this.state.count.outs }
    this.addRuns(advancement.runs)
    this.audio.play(result === 'homeRun' ? 'homeRun' : 'hit')
    if (advancement.runs > 0 && result !== 'homeRun') this.audio.play('score')
    this.shake = result === 'homeRun' ? 13 : 6
    this.completePlateAppearance()
    this.showBallInPlay(result, time, advancement.runs)
  }

  private addRuns(runs: number): void {
    if (runs <= 0) return
    if (this.state.half === 'bottom') this.state.score.player += runs
    else this.state.score.cpu += runs
  }

  private showResult(result: PlayResult, time: number, runs: number): void {
    this.lastPlay = {
      result,
      startedAt: time,
      runs,
      battingTeam: this.state.half === 'bottom' ? 'player' : 'cpu',
      batter: this.getCurrentBatter(),
    }
    this.state.lastResult = result
    this.state.message = resultLabels[result]
    this.state.phase = 'result'
    this.phaseStartedAt = time
    this.syncDom()
  }

  private showBallInPlay(result: ContactResult, time: number, runs: number): void {
    this.lastPlay = {
      result,
      startedAt: time,
      runs,
      battingTeam: this.state.half === 'bottom' ? 'player' : 'cpu',
      batter: this.getCurrentBatter(),
    }
    this.state.lastResult = result
    this.state.message = resultLabels[result]
    this.state.phase = 'ballInPlay'
    this.phaseStartedAt = time
    this.syncDom()
  }

  private finishPlay(time: number): void {
    this.advanceBattingOrder()
    if (isWalkOff(this.state.inning, this.state.half, this.state.score)) {
      this.endGame('player', time)
      return
    }

    if (this.state.count.outs >= 3) {
      const transition = transitionAfterThirdOut(this.state.inning, this.state.half, this.state.score)
      if (transition.kind === 'gameOver' && transition.winner) {
        this.endGame(transition.winner, time)
        return
      }

      this.state.inning = transition.inning
      this.state.half = transition.half
      this.state.count = emptyCount()
      this.state.bases = emptyBases()
      this.state.phase = 'halfIntro'
      this.state.lastResult = null
      this.lastPlay = null
      this.phaseStartedAt = time
      this.state.message = `${this.state.inning}회 ${this.state.half === 'top' ? '초' : '말'} · ${this.state.half === 'top' ? '수비' : '공격'} 시작`
      this.syncDom()
      return
    }

    this.enterAtBat(time)
  }

  private endGame(winner: Winner, time: number): void {
    this.state.phase = 'gameOver'
    this.state.winner = winner
    this.state.lastResult = null
    this.activePitch = null
    this.phaseStartedAt = time
    this.state.message = winner === 'player' ? '승리! 오늘의 히어로는 바로 당신입니다' : winner === 'cpu' ? '아쉽게 패배했습니다. 다시 도전해 보세요' : '연장 끝 무승부입니다'
    if (winner === 'player') this.audio.play('homeRun')
    else if (winner === 'cpu') this.audio.play('out')
    this.syncDom()
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const gameKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Enter']
    if (gameKeys.includes(event.key)) event.preventDefault()
    if (event.repeat && (event.key === ' ' || event.key === 'Enter')) return

    void this.audio.unlock()

    if (event.key.toLowerCase() === 'm') {
      this.toggleMute()
      return
    }

    if (
      event.key.toLowerCase() === 'p' &&
      !['title', 'teamSelect', 'lineupSetup', 'gameOver'].includes(this.state.phase)
    ) {
      this.togglePause(performance.now())
      return
    }

    if (this.state.phase === 'paused') return

    if (this.state.phase === 'title') {
      if (event.key === 'Enter' || event.key === ' ') this.openTeamSelection()
      return
    }

    if (this.state.phase === 'teamSelect' || this.state.phase === 'lineupSetup') return

    if (this.state.phase === 'gameOver') {
      if (event.key.toLowerCase() === 'r' || event.key === 'Enter') this.startGame()
      return
    }

    if (this.state.phase === 'pitching') {
      if (event.key === '1') this.selectPitch('fastball')
      else if (event.key === '2') this.selectPitch('curve')
      else if (event.key === '3') this.selectPitch('changeup')
      else if (event.key.startsWith('Arrow')) this.moveCursor(this.aim, event.key)
      else if (event.key === ' ') this.startPlayerPitch(performance.now())
      this.syncDom()
      return
    }

    const canMoveBat =
      this.state.phase === 'batting' ||
      (this.state.phase === 'pitchInFlight' && this.activePitch?.mode === 'playerBatting')
    if (canMoveBat && event.key.startsWith('Arrow')) {
      this.moveCursor(this.batCursor, event.key)
    }

    if (
      event.key === ' ' &&
      this.state.phase === 'pitchInFlight' &&
      this.activePitch?.mode === 'playerBatting' &&
      this.activePitch.userSwingAt === null
    ) {
      this.activePitch.userSwingAt = (performance.now() - this.activePitch.startedAt) / 1000
      this.activePitch.userSwingAim = { ...this.batCursor }
      this.audio.play('swing')
    }
    this.syncDom()
  }

  private handlePointer(event: PointerEvent): void {
    this.canvas.focus()
    void this.audio.unlock()
    const rect = this.canvas.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH
    const y = ((event.clientY - rect.top) / rect.height) * HEIGHT

    if (this.state.phase === 'title') {
      if (x >= 360 && x <= 600 && y >= 438 && y <= 493) this.openTeamSelection()
      return
    }

    if (this.state.phase === 'gameOver' && x >= 360 && x <= 600 && y >= 427 && y <= 484) {
      this.startGame()
      return
    }

    if (this.state.phase === 'paused' && x >= 360 && x <= 600 && y >= 355 && y <= 412) {
      this.togglePause(performance.now())
    }
  }

  private togglePause(time: number): void {
    if (this.state.phase === 'paused') {
      const pausedDuration = time - this.pausedAt
      this.state.phase = this.pausedPhase
      this.phaseStartedAt += pausedDuration
      this.nextPitchAt += pausedDuration
      if (this.activePitch) this.activePitch.startedAt += pausedDuration
      if (this.lastPlay) this.lastPlay.startedAt += pausedDuration
    } else {
      this.pausedPhase = this.state.phase
      this.pausedAt = time
      this.state.phase = 'paused'
    }
    this.audio.play('select')
    this.syncDom()
  }

  private toggleMute(): void {
    this.state.muted = !this.state.muted
    this.audio.setMuted(this.state.muted)
    if (!this.state.muted) this.audio.play('select')
    this.syncDom()
  }

  private selectPitch(type: PitchType): void {
    if (this.state.selectedPitch === type) return
    this.state.selectedPitch = type
    this.audio.play('select')
  }

  private moveCursor(cursor: Vec2, key: string): void {
    const step = 0.22
    if (key === 'ArrowLeft') cursor.x -= step
    if (key === 'ArrowRight') cursor.x += step
    if (key === 'ArrowUp') cursor.y -= step
    if (key === 'ArrowDown') cursor.y += step
    cursor.x = this.clamp(cursor.x, -1.35, 1.35)
    cursor.y = this.clamp(cursor.y, -1.35, 1.35)
  }

  private pickCpuPitch(): PitchType {
    const roll = Math.random()
    if (this.state.difficulty === 'easy') return roll < 0.68 ? 'fastball' : roll < 0.86 ? 'changeup' : 'curve'
    if (this.state.difficulty === 'normal') return roll < 0.48 ? 'fastball' : roll < 0.76 ? 'curve' : 'changeup'
    return roll < 0.38 ? 'fastball' : roll < 0.7 ? 'curve' : 'changeup'
  }

  private pitchDuration(type: PitchType, multiplier: number): number {
    const base = type === 'fastball' ? 0.88 : type === 'curve' ? 1.08 : 1.18
    return base / multiplier
  }

  private syncDom(): void {
    const half = this.state.half === 'top' ? '초' : '말'
    const roster = this.state.matchRoster
    this.statusText.textContent =
      this.state.phase === 'title'
        ? '2026 KBO · LG 트윈스 vs 한화 이글스'
        : this.state.phase === 'teamSelect' || this.state.phase === 'lineupSetup'
          ? '팀과 9인 타순, 선발투수를 편성하세요'
          : roster
            ? `${this.state.inning}회 ${half} · ${roster.cpuTeam.shortName} ${this.state.score.cpu} : ${this.state.score.player} ${roster.playerTeam.shortName}`
            : this.state.message

    if (this.state.phase === 'title') {
      this.controlHint.textContent = 'Enter를 눌러 팀과 라인업을 선택하세요.'
    } else if (this.state.phase === 'teamSelect' || this.state.phase === 'lineupSetup') {
      this.controlHint.textContent = '마우스 또는 Tab과 Enter로 팀과 선수를 편성하세요.'
    } else if (this.state.phase === 'pitching') {
      this.controlHint.textContent = '방향키로 조준 · 1/2/3 구종 선택 · Space로 투구'
    } else if (this.state.phase === 'batting' || this.activePitch?.mode === 'playerBatting') {
      this.controlHint.textContent = '방향키로 배팅 커서 이동 · 타이밍에 맞춰 Space로 스윙'
    } else if (this.state.phase === 'paused') {
      this.controlHint.textContent = 'P 또는 화면의 계속하기 버튼으로 경기를 재개하세요.'
    } else if (this.state.phase === 'gameOver') {
      this.controlHint.textContent = 'R 또는 Enter로 같은 난이도에 다시 도전하세요.'
    } else {
      this.controlHint.textContent = this.state.message
    }

    this.muteButton.setAttribute('aria-pressed', String(this.state.muted))
    this.muteButton.innerHTML = this.state.muted
      ? '<span aria-hidden="true">×</span> 사운드 꺼짐'
      : '<span aria-hidden="true">♪</span> 사운드 켜짐'
  }

  private render(time: number): void {
    const context = this.context
    context.clearRect(0, 0, WIDTH, HEIGHT)
    context.save()
    if (this.shake > 0) {
      context.translate(Math.sin(time * 0.08) * this.shake * 0.45, Math.cos(time * 0.11) * this.shake * 0.3)
    }

    if (
      this.state.phase === 'title' ||
      this.state.phase === 'teamSelect' ||
      this.state.phase === 'lineupSetup'
    ) {
      this.drawTitle(time)
    } else if (this.state.phase === 'ballInPlay' || (this.state.phase === 'paused' && this.pausedPhase === 'ballInPlay')) {
      this.drawDiamondPlay(time)
    } else {
      this.drawFieldScene(time)
      this.drawHud()
      this.drawMatchupCards()
      if (this.state.phase === 'halfIntro') this.drawHalfIntro()
      if (this.state.phase === 'result') this.drawResultOverlay(time)
      if (this.state.phase === 'gameOver') this.drawGameOver(time)
    }

    if (this.state.phase === 'paused') this.drawPause()
    context.restore()
  }

  private drawTitle(time: number): void {
    const context = this.context
    const sky = context.createLinearGradient(0, 0, 0, HEIGHT)
    sky.addColorStop(0, '#172b62')
    sky.addColorStop(0.56, '#0c4a69')
    sky.addColorStop(1, '#062638')
    context.fillStyle = sky
    context.fillRect(0, 0, WIDTH, HEIGHT)

    context.fillStyle = 'rgba(53, 255, 196, .07)'
    context.beginPath()
    context.arc(480, 420, 360, Math.PI, 0)
    context.fill()
    this.drawCrowd(205, 0.65)

    const glow = context.createRadialGradient(480, 115, 10, 480, 115, 240)
    glow.addColorStop(0, 'rgba(103, 178, 255, .32)')
    glow.addColorStop(1, 'rgba(18, 43, 91, 0)')
    context.fillStyle = glow
    context.fillRect(190, 0, 580, 300)

    this.drawBaseball(480 + Math.sin(time * 0.0017) * 8, 77, 31, -0.28)
    this.text('DUGOUT', 480, 150, 19, '#6fe3bd', 'center', 900, 5)
    this.text('덕아웃 히어로즈', 480, 205, 52, '#ffffff', 'center', 900, -2)
    this.text('2026 KBO 기록으로 완성한 세 이닝 승부', 480, 240, 16, '#a8bddf', 'center', 700)

    context.fillStyle = 'rgba(8, 25, 51, .8)'
    context.strokeStyle = 'rgba(151, 183, 235, .18)'
    context.lineWidth = 1
    this.roundRect(268, 304, 195, 92, 17, true, true)
    context.fillStyle = '#c30452'
    this.roundRect(284, 320, 54, 54, 14, true, false)
    this.text('LG', 311, 354, 18, '#fff', 'center', 900)
    this.text('LG 트윈스', 353, 342, 15, '#fff', 'left', 900)
    this.text('30 PLAYER ROSTER', 353, 365, 9, '#8197bd', 'left', 800, 0.5)

    context.fillStyle = 'rgba(8, 25, 51, .8)'
    this.roundRect(497, 304, 195, 92, 17, true, true)
    context.fillStyle = '#f37321'
    this.roundRect(513, 320, 54, 54, 14, true, false)
    this.text('E', 540, 354, 20, '#fff', 'center', 900)
    this.text('한화 이글스', 582, 342, 15, '#fff', 'left', 900)
    this.text('30 PLAYER ROSTER', 582, 365, 9, '#8197bd', 'left', 800, 0.5)

    context.fillStyle = '#ffcc4d'
    context.shadowColor = 'rgba(255, 202, 70, .35)'
    context.shadowBlur = 24
    this.roundRect(360, 438, 240, 55, 18, true, false)
    context.shadowBlur = 0
    this.text('팀 선택  ENTER', 480, 472, 17, '#17203a', 'center', 900)
    this.text('2026.07.22 KBO 1군 등록 선수 및 누적 기록 기준', 480, 519, 11, '#7188b0', 'center', 700)
  }

  private drawFieldScene(time: number): void {
    const context = this.context
    const sky = context.createLinearGradient(0, 0, 0, 335)
    sky.addColorStop(0, '#48a6dd')
    sky.addColorStop(0.56, '#bfe9ec')
    sky.addColorStop(1, '#f1e4c8')
    context.fillStyle = sky
    context.fillRect(0, 0, WIDTH, 340)

    context.fillStyle = '#244b69'
    context.beginPath()
    context.moveTo(0, 195)
    context.lineTo(115, 132)
    context.lineTo(220, 198)
    context.lineTo(342, 119)
    context.lineTo(480, 198)
    context.lineTo(615, 129)
    context.lineTo(760, 199)
    context.lineTo(867, 141)
    context.lineTo(960, 192)
    context.lineTo(960, 280)
    context.lineTo(0, 280)
    context.closePath()
    context.fill()

    this.drawCrowd(215, 1)

    const grass = context.createLinearGradient(0, 250, 0, HEIGHT)
    grass.addColorStop(0, '#2a9d65')
    grass.addColorStop(1, '#0d6d4b')
    context.fillStyle = grass
    context.fillRect(0, 260, WIDTH, HEIGHT - 260)

    context.fillStyle = '#c99763'
    context.beginPath()
    context.moveTo(480, 274)
    context.lineTo(790, 540)
    context.lineTo(170, 540)
    context.closePath()
    context.fill()
    context.fillStyle = '#2b9160'
    context.beginPath()
    context.moveTo(480, 300)
    context.lineTo(673, 540)
    context.lineTo(287, 540)
    context.closePath()
    context.fill()

    context.strokeStyle = 'rgba(255,255,255,.75)'
    context.lineWidth = 3
    context.beginPath()
    context.moveTo(480, 462)
    context.lineTo(145, 540)
    context.moveTo(480, 462)
    context.lineTo(815, 540)
    context.stroke()

    context.fillStyle = '#bd8c58'
    context.beginPath()
    context.ellipse(480, 274, 45, 14, 0, 0, Math.PI * 2)
    context.fill()

    const isPlayerBatting = this.state.half === 'bottom'
    const roster = this.state.matchRoster
    const pitcherColor = isPlayerBatting
      ? roster?.cpuTeam.primaryColor ?? '#e94b5f'
      : roster?.playerTeam.primaryColor ?? '#256ee8'
    const batterColor = isPlayerBatting
      ? roster?.playerTeam.primaryColor ?? '#256ee8'
      : roster?.cpuTeam.primaryColor ?? '#e94b5f'
    this.drawPitcher(480, 268, pitcherColor, time)
    this.drawCatcher(480, 457, pitcherColor)
    this.drawBatter(635, 431, batterColor, time)

    context.fillStyle = 'rgba(255,255,255,.06)'
    context.strokeStyle = 'rgba(255,255,255,.55)'
    context.lineWidth = 2
    context.setLineDash([8, 8])
    context.fillRect(ZONE_CENTER.x - ZONE_SCALE.x, ZONE_CENTER.y - ZONE_SCALE.y, ZONE_SCALE.x * 2, ZONE_SCALE.y * 2)
    context.strokeRect(ZONE_CENTER.x - ZONE_SCALE.x, ZONE_CENTER.y - ZONE_SCALE.y, ZONE_SCALE.x * 2, ZONE_SCALE.y * 2)
    context.setLineDash([])

    if (this.state.phase === 'pitching') this.drawTarget(this.aim, '#ffcf4a', true)
    const playerCanBat =
      this.state.phase === 'batting' ||
      (this.state.phase === 'pitchInFlight' && this.activePitch?.mode === 'playerBatting')
    if (playerCanBat) this.drawTarget(this.batCursor, '#4b9dff', false)
    if (this.activePitch) {
      this.drawPitch(time)
      this.drawDisciplineHint(time)
    }

    if (this.state.phase === 'pitching') {
      this.drawPitchSelector()
    } else if (this.state.phase === 'batting') {
      this.drawWaitingPill('투수 와인드업 중…')
    }
  }

  private drawCrowd(y: number, scale: number): void {
    const context = this.context
    context.fillStyle = '#173248'
    context.fillRect(0, y - 12, WIDTH, 72 * scale)
    context.fillStyle = '#0c2338'
    context.fillRect(0, y + 48 * scale, WIDTH, 15)
    const colors = ['#f3c653', '#e96870', '#70c9bf', '#dbe8f2', '#6f91d7']
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 42; column += 1) {
        const x = column * 24 + (row % 2) * 9
        const cy = y + row * 16 * scale
        context.fillStyle = colors[(column * 7 + row * 3) % colors.length]
        context.beginPath()
        context.arc(x, cy, 3.2 * scale, 0, Math.PI * 2)
        context.fill()
      }
    }
  }

  private drawPitcher(x: number, y: number, color: string, time: number): void {
    const context = this.context
    const inMotion = this.state.phase === 'pitchInFlight' && this.activePitch !== null
    const elapsed = this.activePitch ? (time - this.activePitch.startedAt) / 1000 : 0
    const motion = inMotion ? Math.sin(Math.min(1, elapsed / 0.3) * Math.PI) : 0
    context.save()
    context.translate(x, y - motion * 4)
    context.scale(0.7, 0.7)
    context.lineCap = 'round'

    context.fillStyle = '#26324b'
    context.beginPath()
    context.ellipse(-13, 47, 11, 25, -0.1, 0, Math.PI * 2)
    context.ellipse(13, 47, 11, 25, 0.1, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = color
    this.roundRect(-30, -8, 60, 61, 17, true, false)
    context.fillStyle = '#f0b47e'
    context.beginPath()
    context.arc(0, -34, 29, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = color
    context.beginPath()
    context.arc(0, -40, 31, Math.PI, 0)
    context.fill()
    context.fillRect(-31, -42, 62, 8)

    context.strokeStyle = '#f0b47e'
    context.lineWidth = 13
    context.beginPath()
    context.moveTo(-23, 5)
    context.lineTo(-39 - motion * 28, 21 - motion * 25)
    context.moveTo(23, 5)
    context.lineTo(36 + motion * 40, -5 - motion * 34)
    context.stroke()
    context.fillStyle = '#4a2c24'
    context.beginPath()
    context.ellipse(-42 - motion * 24, 18 - motion * 22, 14, 11, -0.3, 0, Math.PI * 2)
    context.fill()

    context.fillStyle = '#26324b'
    context.beginPath()
    context.arc(-9, -34, 2.2, 0, Math.PI * 2)
    context.arc(9, -34, 2.2, 0, Math.PI * 2)
    context.fill()
    context.restore()
  }

  private drawBatter(x: number, y: number, color: string, time: number): void {
    const context = this.context
    let swing = 0
    if (this.activePitch?.mode === 'playerBatting' && this.activePitch.userSwingAt !== null) {
      const sinceSwing = (time - this.activePitch.startedAt) / 1000 - this.activePitch.userSwingAt
      swing = this.clamp(sinceSwing / 0.22, 0, 1)
    } else if (this.activePitch?.mode === 'playerPitching' && this.activePitch.cpuSwung) {
      const sinceSwing = (time - this.activePitch.startedAt) / 1000 - this.activePitch.cpuSwingAt
      swing = this.clamp(sinceSwing / 0.22, 0, 1)
    }

    context.save()
    context.translate(x, y)
    context.scale(1.05, 1.05)
    context.lineCap = 'round'
    context.strokeStyle = '#25314a'
    context.lineWidth = 15
    context.beginPath()
    context.moveTo(-13, 34)
    context.lineTo(-24, 65)
    context.moveTo(14, 34)
    context.lineTo(27, 65)
    context.stroke()

    context.fillStyle = color
    this.roundRect(-34, -25, 68, 70, 20, true, false)
    context.fillStyle = '#efb17a'
    context.beginPath()
    context.arc(0, -53, 31, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = color
    context.beginPath()
    context.arc(0, -59, 33, Math.PI, 0)
    context.fill()
    context.fillRect(-35, -61, 70, 8)

    context.save()
    context.rotate(-1.08 + swing * 2.1)
    context.strokeStyle = '#f0b47e'
    context.lineWidth = 13
    context.beginPath()
    context.moveTo(-17, -4)
    context.lineTo(-45, -20)
    context.moveTo(17, -4)
    context.lineTo(-37, -15)
    context.stroke()
    context.strokeStyle = '#e0b06c'
    context.lineWidth = 9
    context.beginPath()
    context.moveTo(-39, -18)
    context.lineTo(-91, -58)
    context.stroke()
    context.restore()

    context.fillStyle = '#26324b'
    context.beginPath()
    context.arc(-9, -53, 2.2, 0, Math.PI * 2)
    context.arc(9, -53, 2.2, 0, Math.PI * 2)
    context.fill()
    context.restore()
  }

  private drawCatcher(x: number, y: number, color: string): void {
    const context = this.context
    context.save()
    context.translate(x, y)
    context.fillStyle = '#202b40'
    context.beginPath()
    context.ellipse(0, 15, 45, 16, 0, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = color
    context.beginPath()
    context.ellipse(0, 0, 32, 28, 0, 0, Math.PI * 2)
    context.fill()
    context.strokeStyle = '#d6e3ef'
    context.lineWidth = 4
    context.beginPath()
    context.arc(0, -23, 20, 0, Math.PI * 2)
    context.stroke()
    context.restore()
  }

  private drawPitch(time: number): void {
    const pitch = this.activePitch
    if (!pitch) return
    const elapsed = (time - pitch.startedAt) / 1000
    const progress = this.clamp(elapsed / pitch.duration, 0, 1)
    const end = this.zoneToScreen(pitch.target)
    const eased = progress * progress * (3 - 2 * progress)
    const pitcher = this.getCurrentPitcher()
    const effectiveStuff = effectivePitcherRating(
      pitcher.ratings.stuff,
      pitcher.ratings.stamina,
      this.getPitcherBattersFaced(),
    )
    const breakScale = pitcherBreakMultiplier(effectiveStuff)
    const curve =
      pitch.type === 'curve'
        ? Math.sin(progress * Math.PI) * 34 * breakScale * pitch.curveDirection
        : 0
    const change = pitch.type === 'changeup' ? Math.sin(progress * Math.PI) * 12 : 0
    const x = this.lerp(480, end.x, eased) + curve
    const y = this.lerp(274, end.y, eased) - Math.sin(progress * Math.PI) * (18 - change)
    const radius = 4 + progress * 7.5
    const context = this.context

    for (let index = 3; index >= 1; index -= 1) {
      const trailProgress = this.clamp(progress - index * 0.035, 0, 1)
      const trailEased = trailProgress * trailProgress * (3 - 2 * trailProgress)
      const trailX =
        this.lerp(480, end.x, trailEased) +
        (pitch.type === 'curve'
          ? Math.sin(trailProgress * Math.PI) * 34 * breakScale * pitch.curveDirection
          : 0)
      const trailY = this.lerp(274, end.y, trailEased) - Math.sin(trailProgress * Math.PI) * (pitch.type === 'changeup' ? 6 : 18)
      context.fillStyle = `rgba(255,255,255,${0.08 + index * 0.04})`
      context.beginPath()
      context.arc(trailX, trailY, radius * (1 - index * 0.11), 0, Math.PI * 2)
      context.fill()
    }

    this.drawBaseball(x, y, radius, progress * 5)
  }

  private drawDisciplineHint(time: number): void {
    const pitch = this.activePitch
    if (!pitch || pitch.mode !== 'playerBatting' || pitch.userSwingAt !== null) return
    const progress = this.clamp((time - pitch.startedAt) / 1000 / pitch.duration, 0, 1)
    const batter = this.getCurrentBatter()
    if (progress < disciplineHintThreshold(batter.ratings.discipline)) return
    const isStrike = isInsideStrikeZone(pitch.target.x, pitch.target.y)
    const color = isStrike ? '#ffcf4a' : '#62dfb3'
    this.context.save()
    this.context.globalAlpha = this.clamp((progress - 0.7) * 3.2, 0, 0.9)
    this.context.strokeStyle = color
    this.context.lineWidth = 3
    this.context.strokeRect(
      ZONE_CENTER.x - ZONE_SCALE.x - 5,
      ZONE_CENTER.y - ZONE_SCALE.y - 5,
      ZONE_SCALE.x * 2 + 10,
      ZONE_SCALE.y * 2 + 10,
    )
    this.context.fillStyle = 'rgba(5, 18, 39, .9)'
    this.roundRect(432, 287, 96, 25, 12, true, false)
    this.text(isStrike ? 'ZONE' : 'TAKE', 480, 304, 10, color, 'center', 900, 1)
    this.context.restore()
  }

  private drawBaseball(x: number, y: number, radius: number, rotation: number): void {
    const context = this.context
    context.save()
    context.translate(x, y)
    context.rotate(rotation)
    context.fillStyle = '#f8fbff'
    context.shadowColor = 'rgba(10, 24, 52, .35)'
    context.shadowBlur = radius * 0.7
    context.beginPath()
    context.arc(0, 0, radius, 0, Math.PI * 2)
    context.fill()
    context.shadowBlur = 0
    context.strokeStyle = '#e44c5d'
    context.lineWidth = Math.max(1, radius * 0.1)
    context.beginPath()
    context.arc(-radius * 0.7, 0, radius * 0.74, -1.05, 1.05)
    context.stroke()
    context.beginPath()
    context.arc(radius * 0.7, 0, radius * 0.74, Math.PI - 1.05, Math.PI + 1.05)
    context.stroke()
    context.restore()
  }

  private drawTarget(target: Vec2, color: string, filled: boolean): void {
    const context = this.context
    const point = this.zoneToScreen(target)
    context.save()
    context.translate(point.x, point.y)
    context.strokeStyle = color
    context.fillStyle = filled ? `${color}33` : 'rgba(0,0,0,0)'
    context.lineWidth = 3
    context.beginPath()
    context.arc(0, 0, 17, 0, Math.PI * 2)
    context.fill()
    context.stroke()
    context.beginPath()
    context.moveTo(-25, 0)
    context.lineTo(-9, 0)
    context.moveTo(9, 0)
    context.lineTo(25, 0)
    context.moveTo(0, -25)
    context.lineTo(0, -9)
    context.moveTo(0, 9)
    context.lineTo(0, 25)
    context.stroke()
    context.restore()
  }

  private drawPitchSelector(): void {
    const context = this.context
    const pitches: Array<{ type: PitchType; key: string }> = [
      { type: 'fastball', key: '1' },
      { type: 'curve', key: '2' },
      { type: 'changeup', key: '3' },
    ]
    context.fillStyle = 'rgba(8, 22, 47, .9)'
    this.roundRect(22, 450, 286, 68, 16, true, false)
    pitches.forEach((pitch, index) => {
      const x = 36 + index * 90
      const selected = pitch.type === this.state.selectedPitch
      context.fillStyle = selected ? '#ffcf4a' : '#18345f'
      this.roundRect(x, 464, 78, 40, 11, true, false)
      this.text(`${pitch.key} ${pitchLabels[pitch.type]}`, x + 39, 489, 11, selected ? '#19213a' : '#bed0ef', 'center', 900)
    })
  }

  private drawWaitingPill(label: string): void {
    const context = this.context
    context.fillStyle = 'rgba(8, 22, 47, .84)'
    this.roundRect(374, 486, 212, 35, 18, true, false)
    this.text(label, 480, 509, 12, '#dce9ff', 'center', 800)
  }

  private drawHud(): void {
    const context = this.context
    const roster = this.state.matchRoster
    if (!roster) return
    context.fillStyle = 'rgba(6, 18, 39, .92)'
    context.strokeStyle = 'rgba(185, 210, 255, .16)'
    context.lineWidth = 1
    this.roundRect(20, 16, 920, 77, 18, true, true)

    this.text(roster.cpuTeam.shortName, 43, 45, 12, roster.cpuTeam.primaryColor, 'left', 900)
    this.text(String(this.state.score.cpu), 147, 72, 30, '#fff', 'center', 900)
    this.text(roster.playerTeam.shortName, 187, 45, 12, roster.playerTeam.primaryColor, 'left', 900)
    this.text(String(this.state.score.player), 291, 72, 30, '#fff', 'center', 900)
    context.fillStyle = '#314563'
    context.fillRect(169, 34, 1, 44)

    this.text(`${this.state.inning}회`, 386, 49, 16, '#fff', 'center', 900)
    this.text(this.state.half === 'top' ? '초 · 수비' : '말 · 공격', 386, 72, 11, '#8fa6cd', 'center', 800)

    this.drawCountDots('B', this.state.count.balls, 4, 462, 40, '#5cdda7')
    this.drawCountDots('S', this.state.count.strikes, 3, 462, 61, '#f2ca53')
    this.drawCountDots('O', this.state.count.outs, 3, 562, 61, '#ff6c73')

    this.drawMiniDiamond(704, 54)
    this.text('구종', 806, 43, 10, '#7890b8', 'left', 800)
    this.text(pitchLabels[this.state.selectedPitch], 806, 68, 16, '#fff', 'left', 900)

    context.fillStyle = '#182d50'
    this.roundRect(887, 34, 34, 34, 10, true, false)
    this.text(this.state.muted ? '×' : '♪', 904, 57, 16, this.state.muted ? '#788bad' : '#72e6bd', 'center', 900)
  }

  private drawMatchupCards(): void {
    const roster = this.state.matchRoster
    if (!roster) return
    const pitcher = this.getCurrentPitcher()
    const batter = this.getCurrentBatter()
    const faced = this.getPitcherBattersFaced()
    const effectiveStuff = Math.round(
      effectivePitcherRating(pitcher.ratings.stuff, pitcher.ratings.stamina, faced),
    )
    const battingLineup =
      this.state.half === 'bottom' ? roster.playerLineup : roster.cpuLineup
    const battingIndex =
      this.state.half === 'bottom' ? this.state.playerBattingIndex : this.state.cpuBattingIndex
    const nextBatter = battingLineup[(battingIndex + 1) % battingLineup.length]
    const context = this.context

    context.fillStyle = 'rgba(5, 18, 39, .86)'
    context.strokeStyle = 'rgba(177, 205, 249, .14)'
    context.lineWidth = 1
    this.roundRect(20, 105, 218, 58, 14, true, true)
    this.text('PITCHER', 34, 124, 8, '#6d85ae', 'left', 900, 1)
    this.text(`#${pitcher.number} ${pitcher.name}`, 34, 146, 15, '#fff', 'left', 900)
    this.text(`구위 ${effectiveStuff}  제구 ${pitcher.ratings.control}`, 146, 125, 9, '#8fa6cd', 'left', 800)
    this.text(
      `ERA ${pitcher.stats.earnedRunAverage.toFixed(2)} · 상대 ${faced}명`,
      146,
      146,
      8,
      '#6f87ae',
      'left',
      800,
    )

    context.fillStyle = 'rgba(5, 18, 39, .86)'
    this.roundRect(704, 105, 236, 58, 14, true, true)
    this.text('BATTER', 718, 124, 8, '#6d85ae', 'left', 900, 1)
    this.text(`#${batter.number} ${batter.name}`, 718, 146, 15, '#fff', 'left', 900)
    this.text(`컨택 ${batter.ratings.contact}  파워 ${batter.ratings.power}`, 824, 125, 9, '#8fa6cd', 'left', 800)
    this.text(
      `OPS ${batter.stats.ops.toFixed(3)} · NEXT ${nextBatter.name}`,
      824,
      146,
      8,
      '#6f87ae',
      'left',
      800,
    )
  }

  private drawCountDots(label: string, active: number, total: number, x: number, y: number, color: string): void {
    const context = this.context
    this.text(label, x, y + 4, 10, '#7890b8', 'left', 900)
    for (let index = 0; index < total; index += 1) {
      context.fillStyle = index < active ? color : '#263a5b'
      context.beginPath()
      context.arc(x + 23 + index * 17, y, 5, 0, Math.PI * 2)
      context.fill()
    }
  }

  private drawMiniDiamond(x: number, y: number): void {
    const context = this.context
    const bases = [
      { x: x + 20, y, active: this.state.bases.second },
      { x: x + 40, y: y + 20, active: this.state.bases.first },
      { x, y: y + 20, active: this.state.bases.third },
    ]
    bases.forEach((base) => {
      context.save()
      context.translate(base.x, base.y)
      context.rotate(Math.PI / 4)
      context.fillStyle = base.active ? '#ffcf4a' : '#2b4165'
      context.fillRect(-7, -7, 14, 14)
      context.restore()
    })
  }

  private drawHalfIntro(): void {
    const half = this.state.half === 'top' ? '초' : '말'
    const role = this.state.half === 'top' ? '수비' : '공격'
    this.drawModalBackdrop()
    this.text(`${this.state.inning}회 ${half}`, 480, 249, 42, '#fff', 'center', 900)
    const team =
      this.state.half === 'top' ? this.state.matchRoster?.cpuTeam : this.state.matchRoster?.playerTeam
    this.text(
      `${team?.shortName ?? ''} ${role} 시작`,
      480,
      287,
      17,
      team?.primaryColor ?? (this.state.half === 'top' ? '#ff9eaa' : '#79b8ff'),
      'center',
      900,
    )
    this.text(this.state.inning === 4 ? '마지막 연장 이닝' : '집중해서 승부하세요', 480, 322, 12, '#a7b9d9', 'center', 700)
  }

  private drawResultOverlay(time: number): void {
    if (!this.lastPlay) return
    const elapsed = (time - this.lastPlay.startedAt) / 1000
    const pop = 1 + Math.sin(Math.min(1, elapsed / 0.18) * Math.PI) * 0.16
    const color = this.lastPlay.result === 'ball' ? '#6be0af' : this.lastPlay.result === 'calledStrike' || this.lastPlay.result === 'strikeout' ? '#ffcf4a' : '#fff'
    this.context.save()
    this.context.translate(480, 300)
    this.context.scale(pop, pop)
    this.context.fillStyle = 'rgba(5, 15, 35, .88)'
    this.roundRect(-145, -55, 290, 110, 22, true, false)
    this.text(resultLabels[this.lastPlay.result], 0, 6, 34, color, 'center', 900)
    if (this.lastPlay.runs > 0) this.text(`+${this.lastPlay.runs}점`, 0, 36, 13, '#74e8bd', 'center', 900)
    this.context.restore()
  }

  private drawDiamondPlay(time: number): void {
    const context = this.context
    const gradient = context.createRadialGradient(480, 390, 20, 480, 390, 500)
    gradient.addColorStop(0, '#3aad70')
    gradient.addColorStop(1, '#0a5f48')
    context.fillStyle = gradient
    context.fillRect(0, 0, WIDTH, HEIGHT)

    context.fillStyle = '#c99662'
    context.beginPath()
    context.moveTo(480, 178)
    context.lineTo(690, 355)
    context.lineTo(480, 500)
    context.lineTo(270, 355)
    context.closePath()
    context.fill()
    context.fillStyle = '#258b5b'
    context.beginPath()
    context.moveTo(480, 213)
    context.lineTo(645, 355)
    context.lineTo(480, 466)
    context.lineTo(315, 355)
    context.closePath()
    context.fill()

    context.strokeStyle = 'rgba(255,255,255,.75)'
    context.lineWidth = 3
    context.beginPath()
    context.moveTo(480, 500)
    context.lineTo(85, 195)
    context.moveTo(480, 500)
    context.lineTo(875, 195)
    context.stroke()
    context.strokeStyle = 'rgba(255,255,255,.28)'
    context.beginPath()
    context.arc(480, 480, 420, Math.PI * 1.15, Math.PI * 1.85)
    context.stroke()

    const points = {
      home: { x: 480, y: 480 },
      first: { x: 645, y: 355 },
      second: { x: 480, y: 213 },
      third: { x: 315, y: 355 },
    }
    Object.values(points).forEach((point) => {
      context.save()
      context.translate(point.x, point.y)
      context.rotate(Math.PI / 4)
      context.fillStyle = '#fff'
      context.fillRect(-9, -9, 18, 18)
      context.restore()
    })

    this.drawHud()
    if (!this.lastPlay) return
    const elapsed = (time - this.lastPlay.startedAt) / 1000
    const progress = this.clamp(elapsed / 1.15, 0, 1)
    const endpoint = this.ballEndpoint(this.lastPlay.result)
    const ballX = this.lerp(points.home.x, endpoint.x, progress)
    const ballY = this.lerp(points.home.y, endpoint.y, progress) - Math.sin(progress * Math.PI) * 105
    this.drawBaseball(ballX, ballY, 7, progress * 7)

    const hitBases = this.lastPlay.result === 'single' ? 1 : this.lastPlay.result === 'double' ? 2 : this.lastPlay.result === 'triple' ? 3 : this.lastPlay.result === 'homeRun' ? 4 : 0
    const battingColor =
      this.lastPlay.battingTeam === 'player'
        ? this.state.matchRoster?.playerTeam.primaryColor ?? '#3c8dff'
        : this.state.matchRoster?.cpuTeam.primaryColor ?? '#ec586a'
    if (hitBases > 0)
      this.drawAnimatedRunner(
        points,
        hitBases,
        this.clamp(elapsed / 1.45, 0, 1),
        battingColor,
      )

    if (this.lastPlay.result === 'homeRun') this.drawConfetti(time)

    context.fillStyle = 'rgba(5, 15, 35, .9)'
    this.roundRect(350, 112, 260, 80, 20, true, false)
    const accent = this.lastPlay.result === 'homeRun' ? '#ffcf4a' : this.lastPlay.result === 'out' ? '#ff8690' : '#72e6bd'
    this.text(resultLabels[this.lastPlay.result], 480, 153, 32, accent, 'center', 900)
    if (this.lastPlay.runs > 0) this.text(`${this.lastPlay.runs}점 득점`, 480, 178, 12, '#d9e6fa', 'center', 800)
  }

  private drawAnimatedRunner(
    points: Record<'home' | 'first' | 'second' | 'third', Vec2>,
    bases: number,
    progress: number,
    color: string,
  ): void {
    const path = [points.home, points.first, points.second, points.third, points.home]
    const totalSegments = bases
    const position = progress * totalSegments
    const segment = Math.min(totalSegments - 1, Math.floor(position))
    const local = position - segment
    const start = path[segment]
    const end = path[segment + 1]
    const x = this.lerp(start.x, end.x, local)
    const y = this.lerp(start.y, end.y, local)
    this.context.fillStyle = color
    this.context.strokeStyle = '#fff'
    this.context.lineWidth = 3
    this.context.beginPath()
    this.context.arc(x, y, 12, 0, Math.PI * 2)
    this.context.fill()
    this.context.stroke()
  }

  private drawConfetti(time: number): void {
    const context = this.context
    const colors = ['#ffcf4a', '#4da1ff', '#ff6573', '#66e1b1', '#fff']
    for (let index = 0; index < 46; index += 1) {
      const x = (index * 83 + time * (0.018 + (index % 4) * 0.003)) % WIDTH
      const y = (index * 41 + time * (0.028 + (index % 3) * 0.004)) % 430 + 95
      context.save()
      context.translate(x, y)
      context.rotate(time * 0.004 + index)
      context.fillStyle = colors[index % colors.length]
      context.fillRect(-4, -2, 8, 4)
      context.restore()
    }
  }

  private drawGameOver(time: number): void {
    this.drawModalBackdrop()
    const winner = this.state.winner
    const title = winner === 'player' ? 'VICTORY' : winner === 'cpu' ? 'GAME OVER' : 'DRAW'
    const roster = this.state.matchRoster
    const korean =
      winner === 'player'
        ? `${roster?.playerTeam.name ?? '사용자 팀'} 승리!`
        : winner === 'cpu'
          ? `${roster?.cpuTeam.name ?? '상대 팀'} 승리`
          : '연장 무승부'
    const color = winner === 'player' ? '#ffcf4a' : winner === 'cpu' ? '#ff8690' : '#8fc3ff'
    if (winner === 'player') this.drawConfetti(time)
    this.text(title, 480, 197, 18, color, 'center', 900, 3)
    this.text(korean, 480, 246, 40, '#fff', 'center', 900)
    this.text(
      `${roster?.cpuTeam.shortName ?? 'CPU'}  ${this.state.score.cpu}  :  ${this.state.score.player}  ${roster?.playerTeam.shortName ?? 'PLAYER'}`,
      480,
      295,
      18,
      '#c7d6ef',
      'center',
      800,
    )
    this.text(this.state.message, 480, 337, 13, '#8fa6cd', 'center', 700)
    this.context.fillStyle = '#ffcf4a'
    this.roundRect(360, 427, 240, 57, 18, true, false)
    this.text('다시 경기  R', 480, 462, 17, '#17203a', 'center', 900)
  }

  private drawPause(): void {
    this.drawModalBackdrop()
    this.text('PAUSED', 480, 235, 15, '#6ee2b9', 'center', 900, 3)
    this.text('잠시 쉬어가기', 480, 284, 36, '#fff', 'center', 900)
    this.text('현재 경기 상태는 그대로 유지됩니다', 480, 321, 12, '#91a7cc', 'center', 700)
    this.context.fillStyle = '#4d9cff'
    this.roundRect(360, 355, 240, 57, 18, true, false)
    this.text('계속하기  P', 480, 390, 17, '#fff', 'center', 900)
  }

  private drawModalBackdrop(): void {
    const context = this.context
    context.fillStyle = 'rgba(3, 10, 25, .74)'
    context.fillRect(0, 0, WIDTH, HEIGHT)
    const glow = context.createRadialGradient(480, 280, 20, 480, 280, 300)
    glow.addColorStop(0, 'rgba(49, 111, 217, .24)')
    glow.addColorStop(1, 'rgba(3, 10, 25, 0)')
    context.fillStyle = glow
    context.fillRect(180, 20, 600, 500)
  }

  private ballEndpoint(result: PlayResult): Vec2 {
    if (result === 'single') return { x: 550, y: 295 }
    if (result === 'double') return { x: 700, y: 235 }
    if (result === 'triple') return { x: 245, y: 220 }
    if (result === 'homeRun') return { x: 480, y: 52 }
    return { x: 355, y: 270 }
  }

  private zoneToScreen(point: Vec2): Vec2 {
    return {
      x: ZONE_CENTER.x + point.x * ZONE_SCALE.x,
      y: ZONE_CENTER.y + point.y * ZONE_SCALE.y,
    }
  }

  private roundRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    fill: boolean,
    stroke: boolean,
  ): void {
    const context = this.context
    context.beginPath()
    context.roundRect(x, y, width, height, radius)
    if (fill) context.fill()
    if (stroke) context.stroke()
  }

  private text(
    value: string,
    x: number,
    y: number,
    size: number,
    color: string,
    align: CanvasTextAlign = 'left',
    weight = 700,
    spacing = 0,
  ): void {
    const context = this.context
    context.fillStyle = color
    context.textAlign = align
    context.textBaseline = 'alphabetic'
    context.font = `${weight} ${size}px Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`
    if (spacing === 0) {
      context.fillText(value, x, y)
      return
    }

    const characters = [...value]
    const width = characters.reduce((total, character) => total + context.measureText(character).width, 0) + spacing * (characters.length - 1)
    let cursor = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x
    context.textAlign = 'left'
    characters.forEach((character) => {
      context.fillText(character, cursor, y)
      cursor += context.measureText(character).width + spacing
    })
  }

  private randomBetween(minimum: number, maximum: number): number {
    return minimum + Math.random() * (maximum - minimum)
  }

  private clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value))
  }

  private lerp(start: number, end: number, progress: number): number {
    return start + (end - start) * progress
  }
}
