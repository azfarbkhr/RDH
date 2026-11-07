# Agent Guide

## Common assignment rules
- Follow this guide, `docs/AGENTS.md` for documentation work, and the assigned role guide at `agent-team/<role>/AGENTS.md`.
- The coordinator dispatches each assignment in a separate chat using the prompt in `agent-team/coordinator/AGENTS.md`. The prompt points to the role guide and relevant files, identifies queue records by ticket ID, and supplies the assignment and current handoff. Each worker verifies its effective workspace access; the coordinator's access is not evidence of the worker's access.
- Use the existing checkout on `main`. Create or use another branch or Git worktree only if the user explicitly directs it. If the checkout is on another branch, tell the coordinator before editing.
- Work only within the assigned scope. Inspect repository files, history, and authoritative sources to resolve routine unknowns independently. Distinguish verified facts, inference, and unresolved decisions; do not guess or ask the user to repeat discoverable information.
- Preserve unrelated edits. Workers record evidence and lifecycle recommendations in the assigned ticket or report. Only the coordinator edits `docs/tickets/tickets.jsonl`.
- Start by checking the assigned workspace, branch, and output path, then attempt the first in-scope write. Do not ask for permission to edit an assigned deliverable. If the runtime denies the write, capture the exact error and return a blocker handoff naming who can resolve it.
- For product questions that repository evidence cannot resolve, prepare a bounded request using `.agents/skills/product-owner-consultation/SKILL.md` and route it through the coordinator. Continue independent work while the answer is pending.
- Record the handoff in the assigned ticket or report. Include the deliverable, changed paths, evidence locations, exact verification and results, limits, open items, and a recommended next action. For blocked work, name the missing evidence or decision and who can provide it. The coordinator names the next owner and sends the candidate commit hash to an independent reviewer before closing a ticket.
- Use synthetic or explicitly authorized statement data. `__OLD__/` is unrelated historical material, not a code, architecture, or data baseline. Do not reuse it as project input or evaluation data.
- No public release, remote push, paid spending, destructive action, or license/ownership decision without owner authorization.
- Keep human-facing folder explanations in `README.md`, agent instructions in `AGENTS.md`, and substantive documentation artifacts under `docs/` as HTML. Use the shared `docs/assets/site.css` and `docs/assets/menu.js` on documentation pages.
- Every Markdown table or grid presented to the user starts with an ID or numbered first column.

## Ticket and queue rules
- The only lifecycle, priority, dependency, and ticket-path source is `docs/tickets/tickets.jsonl`; `docs/tickets/index.html` renders it at runtime.
- Detailed ticket scope, acceptance checks, verification plan, documentation impact, and evidence live in `docs/tickets/<ID>-<slug>/ticket.html`. Do not duplicate lifecycle status or priority there.
- The coordinator alone assigns sequential IDs and edits JSONL. Workers suggest ticket/status changes in their evidence. The coordinator keeps each record aligned with its ticket file and checks IDs, allowed statuses, dependencies, title, and path.
- `done` requires every applicable acceptance check to have evidence and an independent reviewer to pass the exact candidate. Incomplete or blocked work is never marked done.

## Code changes
- Follow the ticket's verification plan. Record commands, results, failures, and limits in the ticket; do not claim checks that were not run.
- The coordinator alone stages and commits. All other roles leave their changes unstaged and report the paths they changed. Follow the coordinator guide for commit preparation and preserve unrelated user changes and staging.
