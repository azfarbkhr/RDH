# Agent Team

Agent Team organizes focused work through role-specific agent instructions. The coordinator assigns bounded work from `docs/tickets/tickets.jsonl`, opens the appropriate role chat with the ticket and current status, and tracks independent review.

The Product Owner sets direction. The Product Researcher gathers evidence, the Requirements Analyst turns it into options and proposed tickets, and the Independent Reviewer checks the proposal before the Product Owner decides. The coordinator records the decision and queues approved work.

The coordinator assigns one role at a time based on the deliverable. The Developer implements ready development tickets. Research, portfolio, and communications tickets go to the relevant role for delivery and then to independent review.

The Program Manager reports project outcomes at [`docs/reports/index.html`](../docs/reports/index.html). The [Scrum Master](scrum-master/AGENTS.md) reviews handoffs and process improvements in a separate periodic retrospective.

The [Chief of Staff](chief-of-staff/AGENTS.md) performs a read-only cross-chat review and routes evidence-backed process, reporting, and prompt recommendations through the coordinator. The [UI Developer](ui-developer/AGENTS.md) owns the complete user tryout flow, the [ML and Inference Engineer](ml-engineer/AGENTS.md) owns reproducible inference and evaluation, and the [Technical Writer](technical-writer/AGENTS.md) owns reader-tested technical and user documentation. These specialists are assigned bounded work by the coordinator; they do not create competing controllers.

Workers use the [Product Owner Consultation skill](../.agents/skills/product-owner-consultation/SKILL.md) to prepare a bounded question for coordinator routing. The skill provides a decision handoff, not a direct permission or authorization grant.

The coordinator can assign a [Personal Social Media Writer](personal-social-media-writer/AGENTS.md) to draft a LinkedIn update that shares a finding and invites community input. A [Blog Writer](blog-writer/AGENTS.md) turns substantial methods or results into longer articles. Both roles draw on completed, independently reviewed research and prepare drafts for the owner to share.
