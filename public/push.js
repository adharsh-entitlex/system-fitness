'use strict';

/* ======================================================================
   Device notifications (Web Push)
   ----------------------------------------------------------------------
   The server keeps the VAPID keys; the browser subscribes with the public
   half and the worker sends reminders even when the tab is closed.
   ====================================================================== */

const PUSH_STATE = {
  supported: typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  configured: false,
  publicKey: null,
  subscribed: false,
  busy: false,
  lastTick: 0
};

/* A browser can sit on the permission prompt or on its push service forever,
   which would leave every notification button dead. Give up and say so. */
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}

function urlBase64ToBytes(base64) {
  const raw = String(base64 || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw + (raw.length % 4 ? '='.repeat(4 - (raw.length % 4)) : '');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pushPermission() {
  return PUSH_STATE.supported ? Notification.permission : 'unsupported';
}

function pushStatusText() {
  if (!PUSH_STATE.supported) return 'This browser cannot show device notifications.';
  if (!PUSH_STATE.configured) return 'Device notifications are not configured on the server yet.';
  if (pushPermission() === 'denied') return 'Notifications are blocked in your browser settings.';
  if (PUSH_STATE.subscribed && state.reminders.enabled) return 'On — reminders reach this device even when the app is closed.';
  if (PUSH_STATE.subscribed) return 'This device is registered. Turn reminders on to receive them.';
  return 'Off. Enable to get reminders on this device.';
}

async function loadPushConfig() {
  try {
    const res = await fetch('/api/push/config', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const data = await res.json();
    PUSH_STATE.configured = !!data.configured;
    PUSH_STATE.publicKey = data.publicKey || null;
  } catch {
    /* offline */
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    PUSH_STATE.subscribed = !!sub;
  } catch {
    PUSH_STATE.subscribed = false;
  }
}

async function postPrefs() {
  if (!auth.user) return;
  try {
    await fetch('/api/push/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: !!(PUSH_STATE.subscribed && state.reminders.enabled),
        everyMin: state.reminders.everyMin
      })
    });
  } catch {
    /* the app still works without server-side reminders */
  }
}

async function enableDevicePush() {
  if (!PUSH_STATE.supported) {
    toast('This browser cannot show device notifications.', 'danger');
    return false;
  }
  if (!auth.user) {
    toast('Create an account or sign in first — reminders are sent from the server.', 'danger');
    return false;
  }
  if (!PUSH_STATE.configured || !PUSH_STATE.publicKey) {
    toast('Notifications are not configured on the server yet.', 'danger');
    return false;
  }

  PUSH_STATE.busy = true;
  try {
    if (pushPermission() !== 'granted') {
      const result = await withTimeout(
        Notification.requestPermission(),
        20000,
        'the browser never answered the permission prompt — allow notifications for this site and try again'
      );
      if (result !== 'granted') {
        toast('Notification permission was not granted. You can allow it in your browser site settings.', 'danger');
        return false;
      }
    }

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await withTimeout(
        reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToBytes(PUSH_STATE.publicKey)
        }),
        20000,
        'this browser could not reach its push service'
      );
    }

    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() })
    });
    if (!res.ok) {
      toast('Could not register this device for notifications.', 'danger');
      return false;
    }

    PUSH_STATE.subscribed = true;
    state.reminders.enabled = true;
    save();
    await postPrefs();
    renderAll();
    toast('Device notifications on. The System will reach you even with the app closed.', 'gold');
    return true;
  } catch (err) {
    toast(`Notifications failed: ${err.message}`, 'danger');
    return false;
  } finally {
    PUSH_STATE.busy = false;
  }
}

async function disableDevicePush() {
  PUSH_STATE.busy = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint })
      }).catch(() => null);
      await sub.unsubscribe().catch(() => null);
    }
  } catch {
    /* nothing registered */
  } finally {
    PUSH_STATE.subscribed = false;
    state.reminders.enabled = false;
    save();
    await postPrefs();
    PUSH_STATE.busy = false;
    renderAll();
    toast('Device notifications off.');
  }
}

async function sendTestPush() {
  if (!auth.user) {
    toast('Sign in first — the server sends the notification.', 'danger');
    return;
  }
  try {
    const res = await fetch('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await res.json().catch(() => null);
    if (res.ok && body && body.sent) toast('Sent. Check your notification shade.', 'gold');
    else toast((body && body.error) || 'No device received it. Enable notifications on this device first.', 'danger');
  } catch {
    toast('Could not reach the server.', 'danger');
  }
}

/* Asks the server whether a reminder is due. Runs on open and on a timer, so
   reminders also arrive on hosts without a cron trigger. */
async function pushTick(force) {
  if (!auth.user || !PUSH_STATE.subscribed || !state.reminders.enabled) return;
  if (!force && Date.now() - PUSH_STATE.lastTick < 60000) return;
  PUSH_STATE.lastTick = Date.now();
  try {
    await fetch('/api/push/tick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        drank: state.water[todayKey()] || 0,
        goal: state.goals.water,
        hour: new Date().getHours(),
        tzOffset: -new Date().getTimezoneOffset()
      })
    });
  } catch {
    /* silent: a missed reminder is not an error worth a toast */
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pushTick(false);
});
setInterval(() => pushTick(false), 120000);

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (PUSH_STATE.busy) return;
  if (el.dataset.act === 'push-enable') {
    const ok = await enableDevicePush();
    if (ok) closeModal();
  } else if (el.dataset.act === 'push-disable') {
    await disableDevicePush();
    closeModal();
  } else if (el.dataset.act === 'push-test') {
    await sendTestPush();
  }
});
