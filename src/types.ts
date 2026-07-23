export type Difficulty = 'easy' | 'normal' | 'hard'
export type Half = 'top' | 'bottom'
export type PitchType = 'fastball' | 'curve' | 'changeup'
export type Winner = 'player' | 'cpu' | 'draw'
export type TeamId = 'LG' | 'HH'
export type PositionGroup = 'pitcher' | 'catcher' | 'infielder' | 'outfielder'

export type ContactResult =
  | 'miss'
  | 'foul'
  | 'out'
  | 'single'
  | 'double'
  | 'triple'
  | 'homeRun'

export type PlayResult = ContactResult | 'ball' | 'calledStrike' | 'walk' | 'strikeout'

export type GamePhase =
  | 'title'
  | 'teamSelect'
  | 'lineupSetup'
  | 'halfIntro'
  | 'batting'
  | 'pitching'
  | 'pitchInFlight'
  | 'ballInPlay'
  | 'result'
  | 'paused'
  | 'gameOver'

export interface HitterStats2026 {
  games: number
  plateAppearances: number
  atBats: number
  hits: number
  doubles: number
  triples: number
  homeRuns: number
  runsBattedIn: number
  stolenBases: number
  caughtStealing: number
  walks: number
  strikeouts: number
  battingAverage: number
  slugging: number
  onBasePercentage: number
  ops: number
  errors: number
  runnersInScoringPositionAverage: number | null
}

export interface PitcherStats2026 {
  games: number
  battersFaced: number
  inningsPitched: number
  hitsAllowed: number
  homeRunsAllowed: number
  walksAllowed: number
  strikeouts: number
  earnedRuns: number
  earnedRunAverage: number
  whip: number
  opponentBattingAverage: number
  qualityStarts: number
}

interface KboPlayerBase {
  id: string
  name: string
  number: string
  batsThrows: string
  birthDate: string
  heightCm: number | null
  weightKg: number | null
  sourceUrl: string
}

export interface KboHitter extends KboPlayerBase {
  kind: 'hitter'
  positionGroup: Exclude<PositionGroup, 'pitcher'>
  stats: HitterStats2026
}

export interface KboPitcher extends KboPlayerBase {
  kind: 'pitcher'
  positionGroup: 'pitcher'
  stats: PitcherStats2026
}

export type KboPlayer = KboHitter | KboPitcher

export interface KboTeam {
  id: TeamId
  name: string
  shortName: string
  primaryColor: string
  secondaryColor: string
  players: KboPlayer[]
}

export interface KboDataSnapshot {
  meta: {
    season: 2026
    snapshotDate: string
    generatedAt: string
    sourceUrl: string
    ratingPool: string
  }
  teams: KboTeam[]
}

export interface HitterRatings {
  contact: number
  power: number
  discipline: number
  speed: number
  clutch: number
  overall: number
}

export interface PitcherRatings {
  stuff: number
  control: number
  stamina: number
  prevention: number
  overall: number
}

export interface RatedHitter extends KboHitter {
  ratings: HitterRatings
}

export interface RatedPitcher extends KboPitcher {
  ratings: PitcherRatings
}

export type RatedPlayer = RatedHitter | RatedPitcher

export interface RatedTeam extends Omit<KboTeam, 'players'> {
  players: RatedPlayer[]
  hitters: RatedHitter[]
  pitchers: RatedPitcher[]
}

export interface LineupSelection {
  teamId: TeamId
  hitterIds: string[]
  pitcherId: string
}

export interface MatchRoster {
  playerTeam: RatedTeam
  cpuTeam: RatedTeam
  playerLineup: RatedHitter[]
  cpuLineup: RatedHitter[]
  playerPitcher: RatedPitcher
  cpuPitcher: RatedPitcher
}

export interface RunnerSlot {
  playerId: string
  name: string
  speed: number
}

export interface Count {
  balls: number
  strikes: number
  outs: number
}

export interface Bases {
  first: RunnerSlot | null
  second: RunnerSlot | null
  third: RunnerSlot | null
}

export interface Score {
  player: number
  cpu: number
}

export interface GameState {
  phase: GamePhase
  inning: number
  half: Half
  count: Count
  bases: Bases
  score: Score
  difficulty: Difficulty
  selectedPitch: PitchType
  lastResult: PlayResult | null
  message: string
  muted: boolean
  winner: Winner | null
  selectedTeamId: TeamId
  matchRoster: MatchRoster | null
  playerBattingIndex: number
  cpuBattingIndex: number
  playerPitcherBattersFaced: number
  cpuPitcherBattersFaced: number
}

export interface Vec2 {
  x: number
  y: number
}

export interface InningTransition {
  kind: 'changeHalf' | 'gameOver'
  inning: number
  half: Half
  winner: Winner | null
}

export interface RunnerAdvance {
  bases: Bases
  runs: number
}

export interface CpuProfile {
  strikeSwingChance: number
  chaseChance: number
  timingSpread: number
  aimSpread: number
  pitchSpeedMultiplier: number
}

export interface ContactRatings {
  contact: number
  power: number
  clutch: number
  pitcherStuff: number
  pitcherPrevention: number
  runnersInScoringPosition: boolean
}
