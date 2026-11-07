/* Render the ticket queue from its canonical JSONL data. */
(() => {
  const source = new URL('./tickets.jsonl', document.currentScript.src);
  const body = document.getElementById('ticket-rows');
  const status = document.getElementById('ticket-queue-status');
  const refresh = document.getElementById('refresh-tickets');

  function addCell(row, value) {
    const cell = document.createElement('td');
    cell.textContent = value;
    row.append(cell);
  }

  function render(records) {
    body.replaceChildren();
    records.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    for (const ticket of records) {
      const row = document.createElement('tr');
      addCell(row, ticket.id);
      addCell(row, String(ticket.priority));
      const title = document.createElement('td');
      const link = document.createElement('a');
      link.href = ticket.ticket;
      link.textContent = ticket.title || ticket.id;
      title.append(link);
      row.append(title);
      addCell(row, ticket.status);
      addCell(row, ticket.depends_on.length ? ticket.depends_on.join(', ') : '—');
      body.append(row);
    }
    status.textContent = `${records.length} ticket${records.length === 1 ? '' : 's'} loaded.`;
  }

  async function loadTickets() {
    status.textContent = 'Loading tickets…';
    try {
      const response = await fetch(source, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const records = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
      render(records);
    } catch (error) {
      body.replaceChildren();
      status.textContent = `Could not load tickets.jsonl (${error.message}). Open this page from a local or hosted web server so the browser can fetch the JSONL file.`;
    }
  }

  refresh.addEventListener('click', loadTickets);
  loadTickets();
})();
