# StayAI agent rules

- Work on your own feature branch: codex/... for Codex and claude/... for Claude Code. Never use main as a working branch.
- Before changing code: fetch origin, compare your branch with origin/main, read the shared board at /internal/launch/, and inspect all active tasks.
- Before starting a board task, make an atomic CLAIM TASK. Start only after CLAIM_SUCCESS.
- If a task is assigned to the other agent, do not change its code or files. A reassignment by an owner is the only exception.
- Declare planned files and scope with the claim. If the board reports FILE_CONFLICT, choose another task or wait; do not work around the conflict.
- Update activity while working. After tests and a commit, record the commit and move the task to «Ждёт проверки». Mark «Готово» only after a real verification.
- If external owner input is required, keep the assignee, set «Нужно действие владельца», explain the one needed action, and claim another non-conflicting task if available.
- Before finishing, fetch again and review any new origin/main changes. Reconcile them before proposing or publishing an integration.
- The shared board is the source of truth for major launch work. Do not create a parallel roadmap.
