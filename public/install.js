'use strict';

/* ======================================================================
   Install & standalone
   ----------------------------------------------------------------------
   A browser tab shows an address bar; the installed app does not. This
   file owns everything about getting the app onto the home screen: the
   Chrome install prompt, the iOS "Add to Home Screen" instructions, the
   dismissable banner and the Settings row.

   The banner is deliberately quiet: it never covers the sign-in gate, an
   open modal or the first-run tour, and one dismissal hides it for good
   on this device.
   ====================================================================== */

const INSTALL_HIDE_KEY = 'system-fitness-install-hidden';

const install = { event: null, installed: false };

function isStandalone() {
  try {
    if (window.matchMedia) {
      if (matchMedia('(display-mode: standalone)').matches) return true;
      if (matchMedia('(display-mode: minimal-ui)').matches) return true;
      if (matchMedia('(display-mode: fullscreen)').matches) return true;
    }
    // iOS Safari reports the home-screen launch here, not in matchMedia.
    if (navigator.standalone === true) return true;
  } catch (err) {
    /* older browser: assume a normal tab */
  }
  return false;
}

function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function installDismissed() {
  try {
    return localStorage.getItem(INSTALL_HIDE_KEY) === '1';
  } catch (err) {
    return false;
  }
}

function installShellBusy() {
  const gate = document.getElementById('authScreen');
  if (gate && !gate.hidden) return true;
  const modal = document.getElementById('modalRoot');
  if (modal && !modal.hidden) return true;
  if (document.body.classList.contains('is-touring')) return true;
  return false;
}

function installAvailable() {
  return !!(install.event || isIos());
}

function installStatusText() {
  if (isStandalone()) return 'Running as the installed app — full screen, offline, one tap from the home screen.';
  if (isIos()) return 'Not installed yet. On iPhone or iPad: tap Share, then Add to Home Screen, then open THE SYSTEM from the icon.';
  if (installAvailable()) return 'Not installed yet. Install it once and it opens in its own window, without browser bars.';
  return 'Not installed yet. On Android: browser menu → Install app. On iPhone: Share → Add to Home Screen.';
}

function paintInstallBar() {
  const bar = document.getElementById('installBar');
  if (!bar) return;
  const hide = isStandalone() || install.installed || installDismissed() || installShellBusy();
  bar.hidden = hide;
  if (hide) return;

  const sub = document.getElementById('installSub');
  if (sub) {
    sub.textContent = install.event
      ? 'Full screen, works offline, one tap from your home screen.'
      : isIos()
        ? 'Tap Share, then “Add to Home Screen”.'
        : 'Open the browser menu and choose “Install app”.';
  }
  const btn = bar.querySelector('[data-act="install-app"]');
  if (btn) btn.textContent = install.event ? 'INSTALL' : 'HOW TO';
}

function maybeShowInstallBar() {
  paintInstallBar();
}

function dismissInstall() {
  try {
    localStorage.setItem(INSTALL_HIDE_KEY, '1');
  } catch (err) {
    /* private mode: the bar just hides for this session */
  }
  const bar = document.getElementById('installBar');
  if (bar) bar.hidden = true;
  toast('Install stays available in Settings → APP.');
}

function openInstallHelp() {
  if (typeof openModal !== 'function') {
    toast('Open the browser menu and choose Install app.');
    return;
  }
  openModal(`
    <h2>INSTALL THE SYSTEM</h2>
    <div class="sub">Put it on your home screen once. After that it opens in its own window, full screen, and still works with no signal.</div>
    <div class="install-steps">
      <div class="istep"><span>1</span><div><b>ANDROID · CHROME</b><p>Tap the ⋮ menu, then <em>Install app</em> (or <em>Add to Home screen</em>).</p></div></div>
      <div class="istep"><span>2</span><div><b>iPHONE · SAFARI</b><p>Tap the Share button, scroll to <em>Add to Home Screen</em>, then <em>Add</em>.</p></div></div>
      <div class="istep"><span>3</span><div><b>OPEN IT FROM THE ICON</b><p>Launching from the icon drops the address bar and gives you the app window.</p></div></div>
    </div>
    <div class="modal-actions">
      <button class="btn primary" data-act="modal-close">GOT IT</button>
    </div>
  `);
}

async function requestInstall() {
  if (isStandalone()) {
    toast('Already installed — you are using the app right now.', 'gold');
    return;
  }
  if (install.event) {
    const event = install.event;
    install.event = null;
    try {
      event.prompt();
      const choice = await event.userChoice;
      if (choice && choice.outcome === 'accepted') {
        install.installed = true;
        paintInstallBar();
        toast('Installing — look for THE SYSTEM on your home screen.', 'gold');
        return;
      }
      toast('Install cancelled. The button is in Settings → APP whenever you want it.');
      paintInstallBar();
      return;
    } catch (err) {
      /* fall through to the written instructions */
    }
  }
  openInstallHelp();
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  install.event = e;
  paintInstallBar();
});

window.addEventListener('appinstalled', () => {
  install.installed = true;
  install.event = null;
  paintInstallBar();
  if (typeof toast === 'function') toast('THE SYSTEM is installed. Open it from your home screen.', 'gold');
});

document.addEventListener('DOMContentLoaded', () => {
  paintInstallBar();
  // Let the first paint, the profile ask and the tour settle before asking.
  [1600, 5200, 12000].forEach((ms) => setTimeout(maybeShowInstallBar, ms));

  // The bar steps aside for the sign-in gate, the profile ask and every modal,
  // then comes back when they close.
  const watch = [document.getElementById('authScreen'), document.getElementById('modalRoot')];
  const observer = new MutationObserver(() => paintInstallBar());
  watch.forEach((el) => { if (el) observer.observe(el, { attributes: true, attributeFilter: ['hidden'] }); });
});
