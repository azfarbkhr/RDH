# Redirect Hub Documentation

Open [index.html](index.html) for the documentation home. Keep folder explanations in README.md, agent instructions in AGENTS.md, and substantive documentation in HTML.

1. [Product](product/index.html) — purpose, users, requirements, scope, and decisions.
2. [Architecture](architecture/index.html) — system design, interfaces, and decisions.
3. [Research](research/index.html) — dated sources, comparisons, experiments, and evidence.
4. [Technical](technical/index.html) — verified developer setup, implementation, testing, and operations.
5. [User guides](user-guides/index.html) — verified workflows, examples, and troubleshooting.
6. [Reports](reports/index.html) — current outcomes, open items, and next actions.
7. [Reviews](reviews/index.html) — independent candidate-specific review evidence.
8. [Tickets](tickets/README.md) — JSONL queue metadata, HTML ticket details, and template.

Shared presentation and navigation live in `assets/site.css` and `assets/menu.js`. Documentation-specific instructions are in [AGENTS.md](AGENTS.md).

For local preview, run `python -m http.server 8765 --bind 127.0.0.1` from the repository root and open [the documentation](http://127.0.0.1:8765/docs/). The ticket queue fetches `tickets/tickets.jsonl` over HTTP.
