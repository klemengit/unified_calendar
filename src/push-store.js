import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { DATA_DIR, writePrivate } from './store.js';

// Web Push state: the server's key pair, the devices that asked for notifications, and hashes
// of the reminders already sent. All of it lives in data/push.json; no setup is needed.
const FILE = path.join(DATA_DIR, 'push.json');
const MAX_SUBSCRIPTIONS = 20;

let state = null;

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    state = {};
  }
  if (!Array.isArray(state.subscriptions)) state.subscriptions = [];
  if (!state.sent || typeof state.sent !== 'object') state.sent = {};
  return state;
}

function persist() {
  writePrivate(FILE, 'push.json', JSON.stringify(state, null, 2));
}

// Generated when a browser first asks for it, so nothing is written until reminders are used.
export function publicKey() {
  const s = load();
  if (!s.vapid?.publicKey || !s.vapid?.privateKey) {
    s.vapid = webpush.generateVAPIDKeys();
    s.subscriptions = []; // subscriptions made against another key are dead
    persist();
  }
  return s.vapid.publicKey;
}

export function hasSubscribers() {
  return load().subscriptions.length > 0;
}

export function subscriptionCount() {
  return load().subscriptions.length;
}

// A browser PushSubscription as JSON: { endpoint, keys: { p256dh, auth } }.
export function isSubscription(sub) {
  return Boolean(
    sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 2000 &&
    typeof sub.keys?.p256dh === 'string' && typeof sub.keys?.auth === 'string'
  );
}

export function addSubscription(sub, label = '') {
  const s = load();
  s.subscriptions = s.subscriptions.filter((x) => x.endpoint !== sub.endpoint);
  s.subscriptions.push({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    label: String(label).slice(0, 100),
    createdAt: new Date().toISOString(),
  });
  // Oldest out first: a reinstalled app leaves its old subscription behind.
  s.subscriptions = s.subscriptions.slice(-MAX_SUBSCRIPTIONS);
  persist();
}

export function removeSubscription(endpoint) {
  const s = load();
  const before = s.subscriptions.length;
  s.subscriptions = s.subscriptions.filter((x) => x.endpoint !== endpoint);
  if (s.subscriptions.length !== before) persist();
}

export function loadSent() {
  return load().sent;
}

export function saveSent(sent) {
  load().sent = sent;
  persist();
}

// Sends `payload` to every subscribed device, or only to `endpoint` when given. A device the push
// service reports as gone (404/410) is dropped. Never throws.
export async function sendPush(payload, { subject, endpoint } = {}) {
  const s = load();
  if (!s.vapid) return 0;
  const targets = endpoint ? s.subscriptions.filter((x) => x.endpoint === endpoint) : s.subscriptions;
  let delivered = 0;
  await Promise.all(targets.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), {
        vapidDetails: { subject, publicKey: s.vapid.publicKey, privateKey: s.vapid.privateKey },
        TTL: 60 * 60,
      });
      delivered += 1;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        console.log(`push: dropping ${sub.label || 'a device'}, the push service no longer knows it`);
        removeSubscription(sub.endpoint);
      } else console.error('push failed:', err.statusCode || '', err.body || err.message);
    }
  }));
  return delivered;
}
