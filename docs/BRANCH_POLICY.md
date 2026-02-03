# Branch Policy

- `develop` is the day-to-day integration branch and default PR base.
- `master` is release/hotfix only and is rarely targeted by PRs.
- CI Smoke must be green: `linux-smoke` and `windows-smoke`.
- Avoid the common mistake of targeting `master` for routine work.

## See also
- CONTRIBUTING_WORKFLOW.md
- RELEASE_PROCESS.md
