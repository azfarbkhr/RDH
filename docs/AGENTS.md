# Documentation Agent Guide

- Follow the shared rules in the root `AGENTS.md`; use this file for documentation-specific requirements.
- Keep `README.md` files human-facing folder guides. Keep agent instructions in `AGENTS.md`. Use HTML for substantive docs and ticket changes (`ticket.html`); use `index.html` for folder landing pages.
- Read the owning documentation and inspect current code before describing behavior. Distinguish current implementation from proposals; keep claims evidence-based and record material unknowns.
- Put product decisions in `docs/product/`, architecture decisions in `docs/architecture/`, dated sources and research in `docs/research/`, verified implementation information in `docs/technical/`, verified user workflows in `docs/user-guides/`, and current status reports in `docs/reports/`.
- Link decisions and evidence from the relevant ticket. Do not copy ticket details into status reports; summarize and link to their source.
- Use `docs/assets/site.css` and `docs/assets/menu.js` on HTML pages. For ticket queue creation, status, or alignment, follow `agent-team/coordinator/AGENTS.md`; never hand-edit queue rows in `docs/tickets/index.html`.
