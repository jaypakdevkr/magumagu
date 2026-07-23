import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'cheerio'

const BASE_URL = 'https://www.koreabaseball.com'
const REGISTER_URL = `${BASE_URL}/Player/Register.aspx`
const SNAPSHOT_DATE = '20260722'
const USER_AGENT = 'Mozilla/5.0 (compatible; DugoutHeroes/1.0; static educational snapshot)'
const OUTPUT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../src/data/kbo-2026-07-22.json')

const teamDefinitions = [
  { id: 'LG', name: 'LG 트윈스', shortName: 'LG', primaryColor: '#c30452', secondaryColor: '#101820' },
  { id: 'HH', name: '한화 이글스', shortName: '한화', primaryColor: '#f37321', secondaryColor: '#10253f' },
]

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: { 'User-Agent': USER_AGENT, ...(options.headers ?? {}) },
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return response
    } catch (error) {
      lastError = error
      if (attempt < attempts) await sleep(500 * attempt)
    }
  }
  throw lastError
}

function parseNumber(value, fallback = 0) {
  const normalized = String(value ?? '').replaceAll(',', '').trim()
  if (!normalized || normalized === '-') return fallback
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseNullableNumber(value) {
  const normalized = String(value ?? '').replaceAll(',', '').trim()
  if (!normalized || normalized === '-') return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function parseInnings(value) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized === '-') return 0
  const [whole, fraction] = normalized.split(/\s+/)
  const base = parseNumber(whole)
  if (fraction === '1/3') return base + 1 / 3
  if (fraction === '2/3') return base + 2 / 3
  return base
}

function tableRecords($) {
  const records = []
  $('table').each((_, table) => {
      const headers = $(table)
        .find('thead th')
        .map((__, cell) => $(cell).text().trim())
        .get()
      const rows = []
      $(table)
        .find('tbody tr')
        .each((__, row) => {
          const cells = $(row)
            .find('td')
            .map((___, cell) => $(cell).text().trim())
            .get()
          if (cells.length > 0) rows.push(cells)
        })
      if (headers.length > 0 && rows.length > 0) records.push({ headers, rows })
    })
  return records
}

function mergeFirstRows(tables, headerStart) {
  const matched = tables.find((table) =>
    headerStart.every((header, index) => table.headers[index] === header),
  )
  if (!matched) return {}
  return Object.fromEntries(matched.headers.map((header, index) => [header, matched.rows[0][index]]))
}

function parseHitterStats($) {
  const tables = tableRecords($)
  const primary = mergeFirstRows(tables, ['팀명', 'AVG', 'G'])
  const secondary = mergeFirstRows(tables, ['BB', 'IBB', 'HBP'])
  return {
    games: parseNumber(primary.G),
    plateAppearances: parseNumber(primary.PA),
    atBats: parseNumber(primary.AB),
    hits: parseNumber(primary.H),
    doubles: parseNumber(primary['2B']),
    triples: parseNumber(primary['3B']),
    homeRuns: parseNumber(primary.HR),
    runsBattedIn: parseNumber(primary.RBI),
    stolenBases: parseNumber(primary.SB),
    caughtStealing: parseNumber(primary.CS),
    walks: parseNumber(secondary.BB),
    strikeouts: parseNumber(secondary.SO),
    battingAverage: parseNumber(primary.AVG),
    slugging: parseNumber(secondary.SLG),
    onBasePercentage: parseNumber(secondary.OBP),
    ops: parseNumber(secondary.OPS),
    errors: parseNumber(secondary.E),
    runnersInScoringPositionAverage: parseNullableNumber(secondary.RISP),
  }
}

function parsePitcherStats($) {
  const tables = tableRecords($)
  const primary = mergeFirstRows(tables, ['팀명', 'ERA', 'G'])
  const secondary = mergeFirstRows(tables, ['SAC', 'SF', 'BB'])
  return {
    games: parseNumber(primary.G),
    battersFaced: parseNumber(primary.TBF),
    inningsPitched: parseInnings(primary.IP),
    hitsAllowed: parseNumber(primary.H),
    homeRunsAllowed: parseNumber(primary.HR),
    walksAllowed: parseNumber(secondary.BB),
    strikeouts: parseNumber(secondary.SO),
    earnedRuns: parseNumber(secondary.ER),
    earnedRunAverage: parseNumber(primary.ERA),
    whip: parseNumber(secondary.WHIP),
    opponentBattingAverage: parseNumber(secondary.AVG),
    qualityStarts: parseNumber(secondary.QS),
  }
}

async function fetchDetail(player) {
  await sleep(260)
  const response = await fetchWithRetry(player.sourceUrl)
  const html = await response.text()
  const $ = load(html)
  return player.kind === 'pitcher'
    ? { ...player, stats: parsePitcherStats($) }
    : { ...player, stats: parseHitterStats($) }
}

function positionFromHeader(header) {
  if (header === '투수') return { kind: 'pitcher', positionGroup: 'pitcher' }
  if (header === '포수') return { kind: 'hitter', positionGroup: 'catcher' }
  if (header === '내야수') return { kind: 'hitter', positionGroup: 'infielder' }
  if (header === '외야수') return { kind: 'hitter', positionGroup: 'outfielder' }
  return null
}

function parseRoster(html) {
  const $ = load(html)
  const players = []
  $('table.tNData').each((_, table) => {
    const headers = $(table)
      .find('thead th')
      .map((__, cell) => $(cell).text().trim())
      .get()
    const category = positionFromHeader(headers[1])
    if (!category) return

    $(table)
      .find('tbody tr')
      .each((__, row) => {
        const cells = $(row)
          .find('td')
          .map((___, cell) => $(cell).text().trim())
          .get()
        const link = $(row).find('a[href*="playerId="]').attr('href')
        if (cells.length < 5 || !link) return
        const id = new URL(link, BASE_URL).searchParams.get('playerId')
        const bodyMatch = cells[4].match(/(\d+)cm,\s*(\d+)kg/)
        if (!id) throw new Error(`선수 ID를 찾을 수 없습니다: ${cells[1]}`)
        players.push({
          id,
          kind: category.kind,
          name: cells[1],
          number: cells[0],
          positionGroup: category.positionGroup,
          batsThrows: cells[2],
          birthDate: cells[3],
          heightCm: bodyMatch ? Number(bodyMatch[1]) : null,
          weightKg: bodyMatch ? Number(bodyMatch[2]) : null,
          sourceUrl: new URL(link, BASE_URL).toString(),
        })
      })
  })
  return players
}

async function fetchTeamRoster(team, initialHtml, cookie) {
  const $ = load(initialHtml)
  const body = new URLSearchParams()
  $('input[type="hidden"][name]').each((_, input) => {
    body.set($(input).attr('name'), $(input).attr('value') ?? '')
  })
  body.set('__EVENTTARGET', 'ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$btnCalendarSelect')
  body.set('ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchTeam', team.id)
  body.set('ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchDate', SNAPSHOT_DATE)

  const response = await fetchWithRetry(REGISTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: REGISTER_URL,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  })
  const roster = parseRoster(await response.text())
  const players = []
  for (const [index, player] of roster.entries()) {
    process.stdout.write(`\r${team.name}: ${index + 1}/${roster.length} ${player.name}   `)
    players.push(await fetchDetail(player))
  }
  process.stdout.write('\n')
  return { ...team, players }
}

async function main() {
  const initialResponse = await fetchWithRetry(REGISTER_URL)
  const cookie = initialResponse.headers
    .get('set-cookie')
    ?.split(',')
    .map((part) => part.split(';')[0])
    .join('; ')
  const initialHtml = await initialResponse.text()
  const teams = []
  for (const team of teamDefinitions) {
    teams.push(await fetchTeamRoster(team, initialHtml, cookie))
  }

  const counts = teams.map((team) => team.players.length)
  if (counts[0] !== 30 || counts[1] !== 30) {
    throw new Error(`예상한 30명 명단과 다릅니다: ${counts.join(', ')}`)
  }

  const snapshot = {
    meta: {
      season: 2026,
      snapshotDate: '2026-07-22',
      generatedAt: new Date().toISOString(),
      sourceUrl: REGISTER_URL,
      ratingPool: 'LG·한화 2026-07-22 1군 등록 선수',
    },
    teams,
  }
  await mkdir(dirname(OUTPUT_PATH), { recursive: true })
  await writeFile(OUTPUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  console.log(`완료: ${OUTPUT_PATH}`)
}

await main()
