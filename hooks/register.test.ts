import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'context-bar',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const row = (name: string, tokens: number, kind: 'used' | 'free' | 'buffer' | 'deferred') => ({
  name,
  tokens,
  color: 'inactive',
  isDeferred: kind === 'deferred',
  kind,
})

const breakdown = (messages: number) => {
  const totalTokens = 4_000 + 16_000 + messages

  return {
    categories: [
      row('System prompt', 4_000, 'used'),
      row('System tools', 16_000, 'used'),
      row('MCP tools (deferred)', 9_000, 'deferred'),
      row('Messages', messages, 'used'),
      row('Free space', 200_000 - 20_000 - totalTokens, 'free'),
      row('Autocompact buffer', 20_000, 'buffer'),
    ],
    totalTokens,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    autocompactSource: 'model-default' as const,
    percentage: Math.round((totalTokens / 200_000) * 100),
    gridRows: [],
    model: 'test',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    autoCompactThreshold: 180_000,
    isAutoCompactEnabled: true,
    apiUsage: null,
  }
}

test('the band breaks the window down by category', async ($, on) => {
  let messages = 64_000
  let hasBreakdown = true

  const toasts: string[] = []
  const time = mock.clock(on, { now: Date.parse('2026-10-12T12:00:00Z') })
  let resetsAt = ''

  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('tool.call', () => ({ result: 'ok' }))
  let compactions = 0
  on('session.compact', () => {
    compactions += 1
    messages = 64_000

    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 1, window: 200_000, percent: 1, ...(hasBreakdown ? { breakdown: breakdown(messages) } : {}) },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 31.4, resetsAt },
        { kind: 'seven_day', percentUsed: 88 },
      ],
      cost: { usd: 0.837 },
    },
  }))

  const tick = () => $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    messages = 64_000
    hasBreakdown = true
    resetsAt = new Date(time.now() + 134 * 60_000).toISOString()
    const ui = await $.ui.mount({ ...BAND, surface })
    await tick()

    const reading = await ui.find({ type: 'Text', text: /^42% $/ })
    expect(reading?.props.color).toBe('success')
    // At 80 columns the token totals and free space give way to the account's figures.
    expect(await ui.find({ type: 'Text', text: /84k \/ 200k/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /free/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^ 5h 31% \(resets 2h14m\)$/ }))?.props.dimColor).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^ · wk 88%$/ }))?.props.color).toBe('error')
    expect(await ui.find({ type: 'Text', text: /^ · \$0\.84$/ })).toBeDefined()

    const wide = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 120 }, surface })
    expect(await wide.find({ type: 'Text', text: /^ 84k \/ 200k$/ })).toBeDefined()
    expect(await wide.find({ type: 'Text', text: /^ · 96k free$/ })).toBeDefined()
    await wide.unmount()
    expect((await ui.find({ type: 'Box', text: /Context/ }))?.props.borderColor).toBe('promptBorder')

    // One segment and one legend entry per used category, each its own colour.
    const segments = (await ui.findAll({ type: 'Text', text: /^ ?━+$/ })).map(s => s.props.color).filter(Boolean)
    expect(segments).toHaveLength(3)
    expect(new Set(segments).size).toBe(3)
    const swatches = (await ui.findAll({ type: 'Text', text: /^● $/ })).map(s => s.props.color)
    expect(swatches).toEqual(segments)

    // The legend is cut to one line of the frame's 76 cells: 4 entries, 3 gaps of 2.
    expect(await ui.find({ type: 'Text', text: /^Messages$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ 64k$/ })).toBeDefined()
    const cut = await ui.find({ type: 'Text', text: /^╍ Autocompact/ })
    expect(cut?.text).toBe('╍ Autocompact… 20k')
    expect(await ui.find({ type: 'Text', text: /^System prompt$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /deferred/ })).toBeUndefined()

    // The bar never outgrows its width, however the cells round.
    const bar = (await ui.findAll({ type: 'Text', text: /^ ?[━╍]+$/ })).map(s => s.text).join('')
    expect(bar.split(' ')).toHaveLength(5)
    expect(bar).toHaveLength(76 - 'Context 42% '.length - ' 5h 31% (resets 2h14m) · wk 88% · $0.84'.length)

    // Nothing at 84k; one warning on the way to the 180k threshold, not one per turn.
    const before = toasts.length
    messages = 150_000
    await time.advance(60 * 60_000)
    await tick()
    // An hour on, the countdown has moved with the clock.
    expect(await ui.find({ type: 'Text', text: /\(resets 1h14m\)/ })).toBeDefined()
    expect(toasts.slice(before)).toEqual(['Context is 85% full: auto-compaction in about 10k tokens'])
    messages = 160_000
    await tick()
    expect(toasts).toHaveLength(before + 1)
    expect((await ui.find({ type: 'Text', text: /^90% $/ }))?.props.color).toBe('error')
    expect((await ui.find({ type: 'Box', text: /Context/ }))?.props.borderColor).toBe('error')

    // The Compact button is offered from 60%, between turns only; a press compacts and reads again.
    expect(await ui.find({ type: 'Button' })).toBeDefined()
    const busy = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true }, surface })
    expect(await busy.find({ type: 'Button' })).toBeUndefined()
    await busy.unmount()
    const compacted = compactions
    await ui.press({ key: 'compact' })
    expect(compactions).toBe(compacted + 1)
    expect(await ui.find({ type: 'Text', text: /^42% $/ })).toBeDefined()
    expect(await ui.find({ type: 'Button' })).toBeUndefined()

    // Mid-turn a tool call takes a reading; a second one right behind it does not.
    messages = 64_000
    await time.advance(5000)
    await $.tool.call({ tool: 'Bash', tool_use_id: `${surface}-1`, command: 'true' })
    expect(await ui.find({ type: 'Text', text: /^42% $/ })).toBeDefined()
    messages = 160_000
    await $.tool.call({ tool: 'Bash', tool_use_id: `${surface}-2`, command: 'true' })
    expect(await ui.find({ type: 'Text', text: /^42% $/ })).toBeDefined()
    // Nor does a subagent's.
    await time.advance(5000)
    await $.tool.call({ tool: 'Bash', tool_use_id: `${surface}-3`, command: 'true', agentId: 'a1' })
    expect(await ui.find({ type: 'Text', text: /^42% $/ })).toBeDefined()

    // No breakdown to be had: the plain bar, from the measurement itself.
    hasBreakdown = false
    await tick()
    expect(await ui.find({ type: 'Text', text: /^1% $/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /^● $/ })).toHaveLength(0)

    await ui.unmount()
  }
})

test('/context-bar switches between full, compact and off, and remembers', async ($, on) => {
  mock.clock(on)
  const kept: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: kept[e.key] }))
  on('store.set', (_, e) => {
    kept[e.key] = e.value

    return { value: undefined }
  })
  // Off, the band passes: what the engine draws there stands, here an empty Box.
  on('ui.render', { component: 'AbovePrompt' }, (engine, e) => h(engine.ui.resolve(e).Box, null))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 1, window: 200_000, percent: 1, breakdown: breakdown(64_000) },
      rateLimits: [],
    },
  }))

  const run = (args: string) =>
    $.command.run({
      command: 'context-bar',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 80 },
    })
  const framed = async (ui: { findAll: (query: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }) =>
    (await ui.findAll({ type: 'Box' })).some(box => box.props.borderStyle === 'round')

  for (const surface of ['terminal', 'desktop'] as const) {
    await run('full')
    const ui = await $.ui.mount({ ...BAND, surface })
    await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
    expect(await framed(ui)).toBe(true)
    expect(await ui.findAll({ type: 'Text', text: /^● $/ })).toHaveLength(3)

    // No argument steps on: full, compact, off.
    expect((await run(''))?.text).toBe('Context bar: one line, no legend.')
    expect(await framed(ui)).toBe(false)
    expect(await ui.findAll({ type: 'Text', text: /^● $/ })).toHaveLength(0)
    expect(await ui.find({ type: 'Text', text: /^42% $/ })).toBeDefined()

    expect((await run(''))?.text).toMatch(/hidden/)
    expect(await ui.find({ type: 'Text', text: /Context/ })).toBeUndefined()
    expect(kept.view).toBe('off')

    expect((await run('sideways'))?.text).toMatch(/Unknown view/)
    expect(kept.view).toBe('off')

    await ui.unmount()
  }
})
