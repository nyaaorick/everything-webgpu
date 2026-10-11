# react — Vite + React

A chat UI over `engine.conversation()`.

```sh
npm install
npm run dev
```

## What to look at

- **[src/useEngine.js](src/useEngine.js)** — the whole integration. The load is
  triggered by a click rather than from an effect, so React StrictMode's
  double-invoke in dev never builds two engines; a ref guards a second
  concurrent call.
- **[src/App.jsx](src/App.jsx)** — `useMemo` holds one `conversation()` for the
  life of the engine. That matters beyond tidiness: every turn of one
  conversation shares a `task`, so it occupies at most one engine and can never
  starve another. A fresh `conversation()` per render would undo that.

Streaming arrives through `chat.say(content, onDelta)`, so the last message in
the log is appended to in place. History is bounded at 12 exchanges by the
recipe — see the README's note on why unbounded history is quadratic here.

## Notes

- **WebGPU required**, and the first load downloads ~0.8 GB. See
  [../bare/README.md](../bare/README.md).
- `vite.config.js` carries the same one-line `optimizeDeps.exclude` as the bare
  example, for the same reason.
