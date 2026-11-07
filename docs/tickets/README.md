# Tickets and Change Requests

This folder contains the ticket queue data in `tickets.jsonl`, its rendered view in `index.html`, a reusable detail template in `TEMPLATE.html`, and one `ticket.html` per ticket. JSONL holds queue metadata; ticket pages hold scope, acceptance checks, and evidence. The coordinator's guide defines how to create and keep these files aligned.

For deferred tickets, `resume_when` records the condition for revisiting the ticket. For other statuses, its value is `null`.

The index loads JSONL in the browser. For local use, serve this folder over HTTP; browsers may block JSONL fetches from `file://` pages.
