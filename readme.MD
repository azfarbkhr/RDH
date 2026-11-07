# Redirect Hub

## Goal

To build a self-hosted link redirection service with following features; 
- keeps shared URLs stable while destinations change
- adds different target based on filters like country or time
- analyse traffic
- an MCP server soagents can manage link redirection

See [current project status](docs/reports/index.html) for planning evidence and open work.

## Project map

1. [redirect_hub/](redirect_hub/) — Django project, authentication, link management, templates, and static assets.
2. [docs/](docs/index.html) — product, architecture, research, technical/user documentation, reviews, and tickets.
3. [agent-team/](agent-team/README.md) — role-based agent workflow and prompts.

