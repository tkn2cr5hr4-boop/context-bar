import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage, Timer } from 'claude-code'

import type { Fill, Part, View } from '../types'

const fill = atom({ plugin: 'context-bar', key: 'fill' } as const, null)

// One per used category, in the order the breakdown lists them.
const PALETTE = ['#4E9AF1', '#F2A33A', '#B07CF0', '#3CC8B4', '#F06C9B', '#C9D24A', '#F0734E', '#7FB2C8']

const view = atom({ plugin: 'context-bar', key: 'view' } as const, 'full')

const COMMAND = 'context-bar'
const STORE_KEY = 'view'
const VIEWS: readonly View[] = ['full', 'compact', 'off']
const SAID: Record<View, string> = {
  full: 'Context bar: full view.',
  compact: 'Context bar: one line, no legend.',
  off: `Context bar hidden. /${COMMAND} brings it back.`,
}

const isView = (value: unknown): value is View => VIEWS.some(one => one === value)

const isWarned = atom({ plugin: 'context-bar', key: 'isWarned' } as const, false)
// The time the countdown is drawn from: set with each reading and once a minute.
const clock = atom({ plugin: 'context-bar', key: 'now' } as const, 0)

const MINUTE = 60_000

// The window whose reset is counted down beside its figure.
const SESSION_LIMIT = 'five_hour'

// `2h14m`, `14m`, `3d4h`: how long until `at`, or nothing once it has passed.
const until = (at: number | null, now: number): string => {
  if (at === null || now <= 0 || at <= now) {
    return ''
  }

  const minutes = Math.max(1, Math.round((at - now) / MINUTE))
  const hours = Math.floor(minutes / 60)

  if (hours >= 24) {
    return `${Math.floor(hours / 24)}d${hours % 24}h`
  }

  return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`
}

const stamp = async ($: EngineInterface) => {
  const at = await $.clock.now()
  await update($, clock, () => at)
}

// Where the warning fires: this share of the auto-compaction threshold, or of
// the whole window when auto-compaction is off.
const WARN_NEAR = 0.9
const WARN_FULL = 0.85

// The fewest cells the bar keeps before the figures beside it give way.
const MIN_BAR = 20

const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: 'wk', spend_limit: 'spend' }

type Figure = { text: string; color?: string }

type Reading =Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>

const toFill = ({ context, rateLimits, cost }: Reading): Fill => {
  const { breakdown } = context
  const limits = rateLimits.map(({ kind, percentUsed, resetsAt }) => {
    const at = resetsAt === undefined ? NaN : Date.parse(resetsAt)

    return { kind, percent: Math.round(percentUsed), resetsAt: Number.isNaN(at) ? null : at }
  })
  const usd = cost?.usd ?? null

  if (!breakdown) {
    return {
      tokens: context.tokens ?? null,
      window: context.window,
      percent: context.percent ?? null,
      parts: [],
      limits,
      usd,
      compactAt: null,
    }
  }

  const parts: Part[] = []

  for (const { name, tokens, kind } of breakdown.categories) {
    if (kind !== 'deferred' && tokens > 0) {
      parts.push({ name, tokens, kind })
    }
  }

  return {
    tokens: breakdown.totalTokens,
    window: breakdown.rawMaxTokens,
    percent: breakdown.percentage,
    parts,
    limits,
    usd,
    compactAt: breakdown.autoCompactThreshold ?? null,
  }
}

// `summary` estimates locally: no token-count requests are sent.
const measure = async ($: EngineInterface, fallback?: Reading): Promise<Fill> => {
  try {
    return toFill(await $.session.usage({ breakdown: 'summary' }))
  } catch (error) {
    if (!fallback) {
      throw error
    }

    return toFill(fallback)
  }
}

const compact = (n: number): string => {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  }

  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`
}

const colorOf = (percent: number) => {
  if (percent >= 85) {
    return 'error'
  }

  return percent >= 60 ? 'warning' : 'success'
}

// Cells per used part: each gets at least one, the widest give way when they overflow.
const cellsOf = (used: Part[], window: number, width: number): number[] => {
  const cells = used.map(part => Math.max(1, Math.round((part.tokens / window) * width)))

  while (cells.length > 0 && cells.reduce((a, b) => a + b, 0) > width) {
    const widest = cells.indexOf(Math.max(...cells))

    if (cells[widest] <= 1) {
      return cells.map((_, i) => (i < width ? 1 : 0))
    }

    cells[widest] -= 1
  }

  return cells
}

// The legend on one line: a tighter gap first, then shorter names, then no counts.
const fitLegend = (parts: Part[], room: number) => {
  const longest = Math.max(0, ...parts.map(part => part.name.length))
  // Whole words only: the first always stays, the rest while they and the ellipsis fit.
  const cut = (name: string, cap: number) => {
    if (name.length <= cap) {
      return name
    }

    const [first, ...words] = name.split(' ')
    let kept = first

    for (const word of words) {
      if (kept.length + 1 + word.length + 1 > cap) {
        break
      }

      kept = `${kept} ${word}`
    }

    return kept === name ? name : `${kept}…`
  }
  const lay = (cap: number, gap: number, hasCounts: boolean) => {
    const names = parts.map(part => cut(part.name, cap))
    const counts = parts.map(part => (hasCounts ? ` ${compact(part.tokens)}` : ''))
    // Each entry leads with its mark and a space.
    const cells = names.reduce((sum, name, i) => sum + 2 + name.length + counts[i].length, 0)

    return { names, counts, gap, isFit: cells + gap * Math.max(0, parts.length - 1) <= room }
  }

  for (const hasCounts of [true, false]) {
    for (let cap = longest; cap >= 1; cap -= 1) {
      for (const gap of cap === longest ? [3, 2] : [2]) {
        const laid = lay(cap, gap, hasCounts)

        if (laid.isFit) {
          return laid
        }
      }
    }
  }

  return lay(1, 1, false)
}

// Stores the reading and warns once per approach: again only after the window
// has dropped back, as a compaction drops it.
const record = async ($: EngineInterface, now: Fill) => {
  await update($, fill, () => now)
  await stamp($)

  const edge = now.compactAt === null ? now.window * WARN_FULL : now.compactAt * WARN_NEAR
  const isNear = now.tokens !== null && now.tokens >= edge
  let wasNear = false
  await update($, isWarned, was => {
    wasNear = was ?? false

    return isNear
  })

  if (!isNear || wasNear || now.tokens === null) {
    return
  }

  const left = now.compactAt === null ? '' : `: auto-compaction in about ${compact(Math.max(0, now.compactAt - now.tokens))} tokens`
  $.ui.toast(`Context is ${now.percent}% full${left}`)
}

export const register: Register = on => {
  let ticking: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Switch the context bar between full, compact and off',
      argumentHint: '[full|compact|off]',
      immediate: true,
    })

    // The view chosen in an earlier session.
    const kept = await $.store.get(STORE_KEY)

    if (isView(kept)) {
      await update($, view, () => kept)
    }

    const now = await measure($)
    await record($, now)

    // Keeps the countdown moving between turns.
    ticking?.cancel()
    ticking = $.clock.every(MINUTE, () => void stamp($))

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()

    if (asked !== '' && !isView(asked)) {
      return { text: `Unknown view "${asked}": use full, compact or off.` }
    }

    let chosen: View = 'full'
    await update($, view, was => {
      // No argument steps to the next view.
      chosen = isView(asked) ? asked : VIEWS[(VIEWS.indexOf(was ?? 'full') + 1) % VIEWS.length]

      return chosen
    })
    await $.store.set(STORE_KEY, chosen)

    return { text: SAID[chosen] }
  })

  on('session.measure', async ($, e, next) => {
    const now = await measure($, e)
    await record($, now)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const now = await read($, fill)
    const shown = await read($, view)
    const at = await read($, clock)

    if (shown === 'off') {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    // The compact view is the bar row alone: no frame, no legend.
    const isSlim = shown === 'compact'
    // The frame's two borders and a cell of padding each side.
    const pad = isSlim ? 0 : 4
    const frameOf = (borderColor: string, borderDimColor: boolean) =>
      isSlim ? {} : { borderStyle: 'round', borderColor, borderDimColor, paddingX: 1, width: e.props.bodyColumns }

    if (now === null || now.percent === null) {
      const window = now === null ? '' : ` / ${compact(now.window)}`

      return (
        <Box {...frameOf('promptBorder', true)}>
          <Text bold>Context</Text>
          <Text dimColor> no reading yet{window}</Text>
        </Box>
      )
    }

    const percent = Math.max(0, now.percent)
    const color = colorOf(percent)
    // The frame matches the prompt's own until the window is filling up.
    const frame = percent >= 60 ? color : 'promptBorder'
    const used = now.parts.filter(part => part.kind === 'used')
    const free = now.parts.find(part => part.kind === 'free')
    const lead = `${percent}% `
    const totals: Figure[] = now.tokens === null ? [] : [{ text: `${compact(now.tokens)} / ${compact(now.window)}` }]
    const room: Figure[] = free ? [{ text: `${compact(free.tokens)} free` }] : []
    const account: Figure[] = [
      ...(now.limits ?? []).map(({ kind, percent: used, resetsAt }) => ({
        text: `${LIMIT_NAMES[kind] ?? kind} ${used}%${kind === SESSION_LIMIT && until(resetsAt ?? null, at) ? ` (resets ${until(resetsAt ?? null, at)})` : ''}`,
        color: used >= 60 ? colorOf(used) : undefined,
      })),
      ...(typeof now.usd === 'number' ? [{ text: `$${now.usd.toFixed(2)}` }] : []),
    ]
    // Each figure costs its text and the separator before it.
    const cellsIn = (figures: Figure[]) => figures.reduce((sum, figure) => sum + 3 + figure.text.length, 0) - 2
    const inner = e.props.bodyColumns - pad - 'Context '.length - lead.length
    // A narrow band keeps the bar and lets the figures beside it go, free space first.
    const trail =
      [[...totals, ...room, ...account], [...totals, ...account], account, totals].find(
        figures => figures.length > 0 && inner - cellsIn(figures) >= MIN_BAR,
      ) ?? []
    const width = Math.max(0, inner - (trail.length > 0 ? cellsIn(trail) : 0))

    const before = [
      <Text bold>Context </Text>,
      <Text bold color={color}>
        {lead}
      </Text>,
    ]
    const after = trail.map(({ text, color: own }, i) =>
      own ? <Text color={own}>{`${i > 0 ? ' · ' : ' '}${text}`}</Text> : <Text dimColor>{`${i > 0 ? ' · ' : ' '}${text}`}</Text>,
    )

    if (used.length === 0) {
      const filled = Math.min(width, percent === 0 ? 0 : Math.max(1, Math.round((percent / 100) * width)))

      return (
        <Box {...frameOf(frame, percent < 60)}>
          {before}
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'━'.repeat(width - filled)}</Text>
          {after}
        </Box>
      )
    }

    const reserve = now.parts.find(part => part.kind === 'buffer')
    // A cell of gap between neighbours: the used parts, the free stretch, the reserve.
    const track = Math.max(0, width - used.length - (reserve ? 1 : 0))
    const cells = cellsOf(used, now.window, track)
    const rest = track - cells.reduce((a, b) => a + b, 0)
    const buffer = reserve ? Math.min(rest, Math.max(1, Math.round((reserve.tokens / now.window) * track))) : 0
    const segments = [
      ...used.map((_, i) => ({ glyphs: '━'.repeat(cells[i]), color: PALETTE[i % PALETTE.length] })),
      { glyphs: '━'.repeat(rest - buffer), color: undefined },
      { glyphs: '╍'.repeat(buffer), color: undefined },
    ].filter(segment => segment.glyphs !== '')
    const bar = (
      <Box>
        {before}
        {segments.map(({ glyphs, color: own }, i) =>
          own ? (
            <Text color={own}>{`${i > 0 ? ' ' : ''}${glyphs}`}</Text>
          ) : (
            <Text dimColor>{`${i > 0 ? ' ' : ''}${glyphs}`}</Text>
          ),
        )}
        {after}
      </Box>
    )

    if (isSlim) {
      return bar
    }

    const hasReserve = reserve !== undefined && buffer > 0
    const legend = fitLegend(hasReserve ? [...used, reserve] : used, e.props.bodyColumns - pad)

    return (
      <Box flexDirection="column" {...frameOf(frame, percent < 60)}>
        {bar}
        <Box columnGap={legend.gap}>
          {used.map((_, i) => (
            <Box>
              <Text color={PALETTE[i % PALETTE.length]}>{'● '}</Text>
              <Text wrap="truncate-end">{legend.names[i]}</Text>
              <Text dimColor>{legend.counts[i]}</Text>
            </Box>
          ))}
          {hasReserve ? (
            <Box>
              <Text dimColor wrap="truncate-end">
                {`╍ ${legend.names[used.length]}${legend.counts[used.length]}`}
              </Text>
            </Box>
          ) : null}
        </Box>
      </Box>
    )
  })
}
