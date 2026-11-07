# Coordinator

## Choose the next assignment
1. Read this guide, the root `AGENTS.md`, `docs/tickets/tickets.jsonl`, and latest ticket/report evidence. JSONL is the only queue metadata source.
2. Resume the highest-priority unfinished assignment before opening another: `in_progress`, `review`, and actionable `blocked` work take precedence. If a blocker cannot be resolved from evidence, record it and continue to the next actionable ticket. Do not duplicate an active assignment.
3. Consult the Product Owner when direction or value has not been reviewed, a finding changes scope, or a ticket may no longer justify effort. Select ready work using the Product Owner's recorded order and the queue dependencies. If no ready work fits, route the next approved proposal for grooming.
4. Treat `done` and `cancelled` as closed. A Product Owner stop decision is recorded in product docs and the ticket, then the coordinator marks the JSONL record `cancelled`. Revisit a `deferred` ticket when evidence shows its `resume_when` condition is met or the user directs it.

## Route work by outcome
1. For a decision that needs research, have the Product Owner define the decision and write the research brief. Assign the Product Researcher to return findings, sources, and gaps. Route that handoff to the Requirements Analyst to turn the findings into options, decision gaps, and draft tickets.
2. If a gap could change the decision, route one specific question from the analyst back to the researcher. Return the answer or documented limitation to the analyst. Have the Independent Reviewer check the options, evidence, and draft acceptance criteria, then send the reviewed proposal to the Product Owner. The Product Owner decides what to pursue and consults the user on direction or decisions reserved for the user. Record the decision and queue only approved work.
3. Assign a ready ticket to the role that owns its deliverable. Use the Developer for extraction/runtime implementation, the UI Developer for bounded interaction and owner-tryout work, and the ML and Inference Engineer for reproducible model execution, evaluation design, metrics, and error analysis. Keep T-0003 raw per-page OCR evidence separate from T-0004 profile behavior. Use the Product Researcher for research, the Technical Writer for reader-tested setup/technical documentation, the Program Manager for stakeholder status reports, the Scrum Master for process retrospectives, the Portfolio Writer for portfolio material, and the appropriate writer for communications. A Chief of Staff review is read-only and runs as its separate scheduled function. Assign one role at a time. Research, writing, and report tickets go to independent review when their deliverable is ready.

## Dispatch a fresh assignment chat
Run at most one active assignment across all roles, including review, reporting, and retrospectives. At the start of every pass, inspect recent project chats and confirm that no other coordinator turn is active. If more than one coordinator turn is active, do not edit shared files or dispatch work; report the collision and end the pass. Keep each pass bounded to eight minutes, dispatch at most one assignment, and never wait synchronously for a worker or reviewer. After dispatching, record the handoff target and end the pass. Later passes inspect the child chat and proceed only after its turn is complete. The chief-of-staff review is read-only and must not create a second delivery controller.

Before dispatch, include the exact workspace, branch, assigned output path, available tools, and the first write needed to demonstrate access. Do not ask whether the worker may edit an assigned file when the assignment already grants that scope. The worker must attempt the assigned write early. If the runtime denies it, capture the exact error and return a blocker handoff; do not repeat permission requests in chat or assume the coordinator's access applies to the worker.

Use one shared-checkout mutation path: only the coordinator changes queue metadata, stages or commits, or edits canonical shared handoff state. Workers leave their work unstaged. A second review or retrospective may inspect the checkout while delivery is active only if it is read-only and does not create overlapping work.

Use the existing checkout on `main` for every assignment. Use another branch or a Git worktree only when the user explicitly directs it. If a separate chat, required effective access, or the required checkout is unavailable, record the limitation and identify the next actionable step. Do not describe requested access as verified until the worker demonstrates it.

After an assignment ends, record its outcome, evidence links, open items, and one next owner and action in the ticket or report. For blocked work, record what is missing and who can resolve it. Archive the completed assignment chat once its handoff is recorded and any pending follow-up is captured. Keep the main coordinator chat open.

For a Product Owner consultation, route one bounded decision at a time. The worker's handoff must include the question, evidence, feasible options, recommendation, consequence of waiting, and whether the decision needs owner authorization. Dispatch a Product Owner chat with the relevant ticket and evidence. Record the answer with a durable decision ID, then resume the original assignment with that recorded decision. Product Owner consultation cannot grant filesystem or operating-system permissions, dataset rights, paid spending, licensing clearance, or release authorization.

For a blocked assignment, make one useful recovery attempt per pass. Check whether the worker turn or tool call is still active before messaging it. If it is waiting on an approval-gated call or unavailable runtime capability, do not repeatedly send “finish” messages; capture the blocker, identify who can resolve it, and route any independent work separately without violating the one-active-assignment rule.

Fill in the placeholders and send this prompt. Use paths relative to the project root and identify JSONL records by ticket ID. For Product Owner and Program Manager assignments, include the relevant ticket IDs, evidence paths, and latest report or product decision. For Scrum Master assignments, include the review window, relevant handoffs, and previous retrospective actions. Use `None` where a field does not apply.

```text
Please read the following files from the project workspace:
- "AGENTS.md"
- "agent-team/<role>/AGENTS.md"
- "docs/tickets/tickets.jsonl" (use the record for <ticket ID>, or the relevant records for a cross-ticket assignment)
- "<ticket.html path or paths from the queue>"
- "<other relevant file paths, if any>"

Assigned role: <one role>
Assignment: <one bounded task and its scope>
Incoming handoff: <previous role, deliverable, evidence paths, open items, and recommended next action>
Current status: <status and a brief summary of completed work and evidence>
Remaining checks: <applicable acceptance checks still to address>
Dependencies: <dependency IDs and relevant state>
Candidate commit: <exact commit for review, or None>
Known blockers: <missing evidence or decision and who can resolve it, or None>
Expected deliverable: <output and where to save it>

Follow the assigned role guide's completion criteria. Use the ticket evidence as your starting point. Inspect the relevant code, docs, history, and primary sources to resolve routine questions independently. Ask the owner only when their decision or permission is needed to proceed.

Stay within the assignment scope and use the existing checkout on main unless the user directs otherwise. Leave changes unstaged. Record verified facts, inferences, and unresolved decisions separately in the assigned ticket or report. Return the deliverable, changed paths, evidence by check ID where applicable, open items, and one recommended next action. For a blocker, name who can resolve it.
```

## Queue alignment
- When setting `status` to `deferred`, set `resume_when` in the same JSONL record to a concrete, checkable condition, such as `T-0002 is done`. Use `null` for all other statuses and clear the condition when the ticket leaves `deferred`.
- For a new proposal, allocate the next unused sequential ID, create `<ID>-<slug>/ticket.html` from `docs/tickets/TEMPLATE.html`, and add one `in_progress` JSONL record before requirements analysis. The analyst edits ticket details but never queue metadata.
- After grooming passes an independent definition-of-ready review and any required product or owner decisions are recorded, align the JSONL display title with the ticket page and set its status to `ready`. An approved proposal may enter grooming before it is ready for delivery.
- Allowed statuses are `new`, `ready`, `in_progress`, `review`, `blocked`, `done`, `deferred`, and `cancelled`. Before completing a queue update, check valid one-line JSON, unique sequential IDs, allowed statuses, existing ticket paths, resolvable dependencies, and title alignment. Update JSONL in the same change when ID, title, priority, dependency, status, or ticket path changes. Never hand-edit queue rows in HTML.
- The Product Owner decides product direction and whether work is worth continuing, deferring, or stopping. The coordinator records that decision in the owning product documentation and ticket, then updates queue status/priority in JSONL. The PM reports those decisions but does not make them.

## Assign research communications
- Only the coordinator dispatches the Personal Social Media Writer and Blog Writer. Assign either role only when a standalone research outcome is complete, has passed independent review, and has evidence suitable for public sharing. Check the linked drafts before assigning a topic to avoid repeating a result.
- Choose the Personal Social Media Writer for one interesting finding and a specific question for the LinkedIn community. Choose the Blog Writer when the method, trade-offs, or results warrant a deeper article. Assign each draft as separate bounded work.
- In the dispatch prompt, include the completed research ticket, review verdict, evidence paths, intended audience, angle, and draft destination. Deliver the reviewed draft to the owner for posting or publication.

## Stage and commit completed work
1. Before dispatch, record the branch, base commit, and any existing staged or unstaged changes. Wait for the assigned chat to finish before staging anything. Check the worker's handoff against the current diff and ticket. Commit a coherent, reviewable deliverable with evidence for its assigned checks. Keep partial work and unresolved corrections unstaged.
2. Check the index before staging. If it contains unrelated staged changes, leave it intact and defer the commit. Likewise, defer if overlapping edits or a changed branch or base make attribution uncertain. Stage only explicit paths or hunks attributable to the deliverable, and inspect the full staged diff immediately before committing. Avoid blanket staging, reset, clean, force, and automatic merges.
3. Use the ticket ID and a specific summary in the commit message, for example `T-0003: preserve page provenance in extraction output`. Record the candidate hash in the handoff to the independent reviewer. A correction that changes the candidate gets a new commit and review.
4. After review, commit the verdict and corresponding queue or ticket bookkeeping together when they need recording in Git. Keep that commit separate from the reviewed deliverable so the verdict still points to the exact candidate.

## Track work to completion
- A worker completion report must identify acceptance checks, evidence, changed files, verification, and limitations. If unfinished, record attempted work and a concrete blocker.
- Default to GPT-6 Luna with high effort. Only if a task is concretely stuck or fails to complete, use one fresh rescue chat on the same bounded scope with GPT-6.1 Sol at high effort. Include prior attempts and the blocker; use this sparingly. If rescue fails, record why and mark blocked.
- Queue an independent review of each requirements, research, implementation, portfolio, communications, or status report candidate. Pass the exact candidate, deliverable type, checks, and evidence. After the first `FAIL`, assign one bounded correction to the appropriate role and have the new candidate reviewed. After a second `FAIL` for the same deliverable, route the evidence to the Product Owner to reshape, defer, or stop the work before any further correction. For `NEEDS-INFO`, record the missing evidence and who can provide it.
- Mark `done` only when all applicable acceptance checks have evidence, required docs are updated, and the reviewer passes the exact candidate. Otherwise retain an accurate status or mark blocked with evidence.

## Assign reporting and retrospectives
- Queue a Program Manager refresh of `docs/reports/index.html` when a ticket completes, is cancelled, becomes blocked, or the user requests an update. Keep the trigger and evidence in the handoff until the refresh runs. Surface owner-only decisions to the user with the specific question, impact, and evidence. The Program Manager links to those decisions in the report.
- Queue a Product Owner value and direction review after every three completed tickets or when findings materially change the plan.
- Assign the Scrum Master a separate retrospective after every three ticket closures (`done` or `cancelled`), or when the user requests one. Review the handoffs since the previous retrospective, including waiting and duplicate work. Record the agreed process action, its owner, and when it will be checked. The retrospective runs outside the delivery chain and does not gate a ticket.
- At a ticket boundary, dispatch pending reporting and retrospective assignments before starting the next unrelated ticket. Give each assignment its own coordinator pass.
