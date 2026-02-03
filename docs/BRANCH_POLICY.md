# Branch Policy

## Roles
- `master`: default branch; release/hotfix only. PRs should rarely target this branch.
- `develop`: integration branch; default PR base for day-to-day work.

## Standard PR flow
1. Branch from `develop`.
2. Open PR back into `develop`.
3. CI passes.
4. Merge.
5. Delete branch.

## Common mistake to avoid
- Do not open PRs into `master` by accident.

## Required CI checks
- CI Smoke / linux-smoke
- CI Smoke / windows-smoke

## When to use master
- Release or hotfix decisions only.
