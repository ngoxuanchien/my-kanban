# Open external links from the desktop app

Date: 2026-10-31
Status: approved (user asked for a fix, 2026-10-31)

## 1. Problem
In the desktop app, clicking a URL does nothing. Two paths drop it:

1. **Terminal links** (agent output). `web-ui/src/terminal/persistent-terminal-manager.ts:193` loads `new WebLinksAddon()` with its default handler. That handler (`@xterm/addon-web-links`, `function w`) calls `window.open()` with **no URL**, then sets `location.href` on the new window. Electron passes `about:blank` to `setWindowOpenHandler` (`packages/desktop/src/window-registry.ts:119`), which denies every non-http(s) URL, so `window.open()` returns `null` and xterm logs `Opening link blocked as opener could not be cleared`.
2. **Plain `<a href>` links without `target="_blank"`** to another origin. `will-navigate` (`packages/desktop/src/window-registry.ts:98`) calls `preventDefault()` and does nothing else, so the click is silently swallowed.

`window.open(url)` with an http(s) URL already works: the open handler sends it to `shell.openExternal`.

## 2. Goals
- G1. Clicking an http(s) URL in a task terminal opens it in the system browser.
- G2. A cross-origin http(s) navigation in the app window opens in the system browser instead of being dropped. The app window stays on the board.
- G3. Security unchanged: non-http(s) schemes (`javascript:`, `file:`, custom) are still refused; same-origin navigation still allowed.

## 3. How (decided)
- Terminal: `new WebLinksAddon((_event, uri) => { window.open(uri, "_blank", "noopener,noreferrer"); })`. Works in the browser too.
- `will-navigate`: for a cross-origin http(s) URL, keep `preventDefault()` and call the same `shell.openExternal(...).catch(log)` used in `setWindowOpenHandler` (extract one small local helper, used by both).

## 4. Non-goals
- Opening links inside an in-app browser pane.
- Changing which schemes are allowed.

## 5. Verification
- `packages/desktop/test/window-registry.test.ts`: cross-origin http(s) `will-navigate` → `preventDefault` + `shell.openExternal(url)`; same-origin → not prevented, no open; `javascript:`/`file:` → prevented, no open.
- `npm run typecheck`, `npm run lint`, `npm run test:fast`, plus the desktop package tests.
- Manual (after rebuilding the app): print a URL in a task terminal, Cmd/click it → system browser opens.
