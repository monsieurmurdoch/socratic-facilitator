# Contributing

## Branching Rules

`main` should stay deployable.

- Do not start feature work directly on `main`.
- Use a branch for every change, even small fixes.
- Preferred branch prefixes:
  - `fix/...`
  - `feature/...`
  - `chore/...`
  - `research/...`
  - `codex/...`
- Keep each branch scoped to one coherent change.
- Merge branches back promptly and delete them after merge.
- If a branch becomes stale, either merge it, close it, or explicitly mark it abandoned.

## Pull Request Expectations

- Explain the user-visible change first.
- Call out any schema, env, or deployment implications.
- Include verification notes:
  - what you tested
  - what you did not test
- Prefer small PRs over long-running mega branches.

## Main Branch Hygiene

- `main` is for reviewed, intentional work only.
- Hotfixes on `main` should be rare and followed by a cleanup PR if needed.
- Before pushing, run at least the relevant targeted checks for the files you touched.
- Avoid leaving scratch files, duplicate files, or local experiment artifacts unignored.

## UI / Product Changes

- Preserve the two-click guest join flow unless the task explicitly changes it.
- Teacher flows should stay class-room centered:
  - persistent room code
  - session timeline
  - clear source-text flow

## Source Text / AI Behavior

- If a feature relies on source text, make the upload or paste path explicit in the UI.
- Never imply Plato can cite or locate text that is not actually grounded.
- Prefer clear teacher-facing language over internal terminology.
