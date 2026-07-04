// Shared top navigation bar, injected into #app-nav on every page that
// includes this script. Renders role-aware hover dropdown menus, then hands
// back the logged-in session info via the returned promise so each page can
// do its own role gating without a second /api/me round trip.

const ROLE_HIERARCHY = ['user', 'admin', 'super_admin'];

function navRoleAtLeast(role, min) {
  return ROLE_HIERARCHY.indexOf(role) >= ROLE_HIERARCHY.indexOf(min);
}

function renderNav(activePage) {
  const mount = document.getElementById('app-nav');
  if (!mount) return Promise.resolve({ loggedIn: false });

  mount.innerHTML = `
    <nav class="topnav">
      <div class="topnav-inner">
        <a class="topnav-brand" href="/dashboard.html">
          <span class="topnav-brand-mark">&#10022;</span> Lexicon Quest
        </a>
        <div class="topnav-menus" id="topnavMenus"></div>
        <div class="topnav-user" id="topnavUser"></div>
      </div>
    </nav>
  `;

  const menusEl = document.getElementById('topnavMenus');
  const userEl = document.getElementById('topnavUser');

  function menu(label, items) {
    const visible = items.filter(Boolean);
    if (!visible.length) return '';
    return `
      <div class="topnav-item">
        <button type="button" class="topnav-link">${label} <span class="topnav-caret">&#9662;</span></button>
        <div class="topnav-dropdown">
          ${visible
            .map(
              (item) => `<a href="${item.href}" class="topnav-dropdown-link${activePage === item.key ? ' active' : ''}">
                <span class="topnav-dropdown-title">${item.title}</span>
                <span class="topnav-dropdown-desc">${item.desc}</span>
              </a>`
            )
            .join('')}
        </div>
      </div>
    `;
  }

  return fetch('/api/me')
    .then((res) => res.json())
    .then((data) => {
      const role = ROLE_HIERARCHY.includes(data.role) ? data.role : 'user';

      menusEl.innerHTML = [
        menu('Learn', [
          { key: 'practice', href: '/practice.html', title: 'Practice', desc: 'Flashcard review, due words first' },
          { key: 'side-quests', href: '/side-quests.html', title: 'Side Quests', desc: 'Story-driven word journeys' },
          { key: 'words', href: '/words.html', title: 'Word Bank', desc: 'Browse every word on the platform' }
        ]),
        menu('Dashboard', [
          { key: 'dashboard', href: '/dashboard.html', title: 'Overview', desc: 'Your account & education feed' }
        ]),
        data.loggedIn && navRoleAtLeast(role, 'admin')
          ? menu('Manage', [
              { key: 'words', href: '/words.html', title: 'Word Bank', desc: 'Add or remove vocabulary' },
              { key: 'dashboard', href: '/dashboard.html', title: 'Users & Content', desc: 'On the Dashboard page' }
            ])
          : ''
      ].join('');

      if (data.loggedIn) {
        userEl.innerHTML = `
          <div class="topnav-item topnav-item-user">
            <button type="button" class="topnav-link topnav-avatar">${(data.username || '?').slice(0, 1).toUpperCase()}</button>
            <div class="topnav-dropdown topnav-dropdown-right">
              <div class="topnav-dropdown-account">Signed in as <strong>${data.username}</strong></div>
              <a href="/profile.html" class="topnav-dropdown-link${activePage === 'profile' ? ' active' : ''}">
                <span class="topnav-dropdown-title">Profile</span>
                <span class="topnav-dropdown-desc">Account & translation language</span>
              </a>
              <button type="button" id="navLogoutBtn" class="topnav-dropdown-link topnav-dropdown-logout">Log out</button>
            </div>
          </div>
        `;
        document.getElementById('navLogoutBtn').addEventListener('click', async () => {
          await fetch('/api/logout', { method: 'POST' });
          window.location.href = '/login.html';
        });
      } else {
        userEl.innerHTML = `<a class="topnav-link" href="/login.html">Log in</a>`;
      }

      return data;
    });
}
