The planner fills this template in for every Kanban task.

## Goal
<one sentence>

## Context you need (copied from memory / plan — do not search for it)
- <decision or convention, with file path:line>
- ...

## Files you may change
- <exact paths>. Do not touch any other file.

## Acceptance criteria (the reviewer checks exactly these)
1. <observable behaviour or command> → <expected result>
2. `npm run typecheck` passes; `npm run web:typecheck` passes; `npm run test:fast` passes; `npm run lint` passes; `npm --prefix web-ui run test` passes; `npm run web:build` passes.
3. If the task adds or changes a user-visible feature or CLI flag: `README.md` "Fork features" describes it (one bullet, matching the real flag names). List `README.md` under "Files you may change".

## Out of scope
- <things not to do>

## When done

If a command will run longer than 10 minutes, start it in the background, then run `<kanban prefix> task report --state waiting --reason "<what and how long>" --pid <pid>` before you end your turn. Kanban wakes you when the process exits.
Run every acceptance command yourself and paste the output in your last message.
If you cannot finish without a decision from the owner, run `<kanban prefix> task report --state blocked --question "<one concrete question>"` and stop. Ask one question only.
If you made a decision others need later, record it with the memory tool in contexte/<topic>.md.
