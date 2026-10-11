# Role prompts

One Markdown file per role, shipped in the repo (the original factory discovered its `/work*` commands from a developer's `~/.claude`, which is why they were lost). Variables: `{{ticket.key}}`, `{{ticket.title}}`, `{{ticket.body}}`, `{{cwd}}`, `{{branch}}`, `{{artifacts}}` (the run directory outside the worktree, where `plan.md`, `test-report.md`, `review.md` live).
