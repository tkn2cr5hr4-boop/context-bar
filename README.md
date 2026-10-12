# context-bar

A Claude Code mod that shows how full the context window is in a bar above the prompt: a breakdown by category, rate-limit and cost figures, a countdown to the session limit's reset, and a warning before auto-compaction.

## Install

At the Claude Code prompt in a terminal:

```
/plugin install context-bar --marketplace tkn2cr5hr4-boop/context-bar
```

Answer `y` to add the marketplace, then choose the user scope.

## Use

`/context-bar` steps between the full view, a one-line compact view, and off. `/context-bar full`, `compact` or `off` picks one directly.
