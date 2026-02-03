# Contributing Workflow (Protected Branches + CI Smoke)

## Branch roles
- `master`: default branch, protected.
- `develop`: integration branch, protected.
- `feature/*`: new features.
- `fix/*`: bug fixes.
- `chore/*`: maintenance and tooling.
- `docs/*`: documentation-only changes.

## Rules
- No direct pushes to `master` or `develop`. Use PRs.
- PR base is usually `develop`.
- Use `master` as base only for release/hotfix decisions.
- Required checks: CI Smoke `linux-smoke` and `windows-smoke`.

## Step-by-step flow
1. Sync `develop`.
2. Create a topic branch.
3. Commit your changes.
4. Push the branch.
5. Open a PR (base `develop`).
6. Wait for CI Smoke checks.
7. Merge after approval.
8. Delete the branch.

## Common pitfalls
- Wrong PR base (accidentally targeting `master`).
- Huge PRs that are hard to review.
- Missing `package-lock.json` (CI requires it).
- Workflow triggers not matching branch names.
- Local changes not rebased on latest `develop`.

## Commands (copy/paste)
```bash
git checkout develop
git pull origin develop
git checkout -b feature/short-description

git status -sb
git add .
git commit -m "feat: short description"

git push -u origin feature/short-description
```

```bash
# After merge
git checkout develop
git pull origin develop
git branch -d feature/short-description
git push origin --delete feature/short-description
```
