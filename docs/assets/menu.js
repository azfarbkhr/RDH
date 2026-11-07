/* Add the shared navigation menu to every documentation page. */
(() => {
  const script = document.currentScript;
  if (!script || !document.body || document.querySelector('.site-header')) return;
  const docsRoot = new URL('../', script.src);
  const links = [
    ['Product', 'product/index.html'],
    ['Architecture', 'architecture/index.html'],
    ['Research', 'research/index.html'],
    ['Technical', 'technical/index.html'],
    ['User guides', 'user-guides/index.html'],
    ['Reports', 'reports/index.html'],
    ['Ticket queue', 'tickets/index.html'],
  ];
  const header = document.createElement('header');
  header.className = 'site-header';
  const nav = document.createElement('nav');
  nav.className = 'site-nav';
  nav.setAttribute('aria-label', 'Documentation');

  const brand = document.createElement('a');
  brand.className = 'site-brand';
  brand.href = new URL('index.html', docsRoot).href;
  brand.textContent = 'Redirect Hub';
  nav.append(brand);

  const list = document.createElement('ul');
  list.className = 'site-links';
  for (const [label, path] of links) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = new URL(path, docsRoot).href;
    link.textContent = label;
    if (new URL(location.href).pathname === new URL(link.href).pathname) {
      link.setAttribute('aria-current', 'page');
    }
    item.append(link);
    list.append(item);
  }
  nav.append(list);
  header.append(nav);
  document.body.prepend(header);
})();
