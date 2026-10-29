# Quota and agent score smoke test

Run the isolated, headless Playwright smoke test from the repository root:

```sh
npm --prefix web-ui run e2e:quota-scores
```

The command seeds a temporary runtime home, starts the Kanban runtime, and removes the temporary state when it exits. It does not launch coding agents or call models.

## Manual checklist

After rebuilding Kanban.app, verify these behaviors with real agents:

- An agent that hits its usage limit hands off immediately.
- When all agents are out of quota, the card shows “Out of quota” and is retried after one hour.
- A sidebar review pass or fail updates that agent’s top-bar score.
