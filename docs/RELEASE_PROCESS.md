# Release Process

## Purpose
Define the standard, repeatable steps for cutting releases and hotfixes while keeping protected branches stable.

## Branch model summary
- `develop`: day-to-day integration branch.
- `master`: release/hotfix branch only.

## Pre-release checklist
- CI Smoke is green (`linux-smoke` and `windows-smoke`).
- `package-lock.json` is present and committed.
- Changes are scoped and reviewed (small PRs preferred).
- Release notes or summary are prepared.

## Standard release flow (develop -> PR into master)
1. Sync local branches.
2. Create a release branch.
3. Open a PR targeting `master`.

Commands:
```bash
git checkout develop
git pull origin develop
git checkout master
git pull origin master

# Create release branch (choose one pattern)
git checkout -b release/2026-02-03
# or
git checkout -b release/vX.Y.Z

git push -u origin release/2026-02-03
```

Open a PR from `release/*` into `master` and wait for CI checks to pass.

## Tagging and versioning
- Use SemVer tags (e.g., `v0.1.0`).
- Create tags after the `master` PR is merged.

Commands:
```bash
git checkout master
git pull origin master
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

## Hotfix flow
1. Branch from `master`.
2. PR back into `master`.
3. Cherry-pick or back-merge into `develop`.

Commands:
```bash
git checkout master
git pull origin master
git checkout -b hotfix/short-description

git push -u origin hotfix/short-description
```

After merge to `master`, back-merge into `develop`:
```bash
git checkout develop
git pull origin develop
git merge origin/master
git push origin develop
```

If a single commit needs to be applied:
```bash
git checkout develop
git pull origin develop
git cherry-pick <commit-sha>
git push origin develop
```

## Rollback note
Rollback via a revert commit and PR. Avoid force-pushing protected branches.
