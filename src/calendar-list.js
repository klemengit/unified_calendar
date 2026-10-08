import { getSettings, getGoogleCalendars, getFeeds, getCaldavAccounts } from './store.js';

// Shared by GET /api/calendars and the widget routes.
export function listCalendars(sessionLike) {
  const tokens = sessionLike.tokens || {};
  const { providers } = getSettings();
  const calendars = [];

  if (tokens.microsoft) {
    calendars.push({
      id: 'microsoft',
      kind: 'provider',
      name: tokens.microsoft.email || tokens.microsoft.name || 'Outlook',
      color: providers.microsoft.color,
      visible: providers.microsoft.visible !== false,
    });
  }

  if (tokens.google) {
    const gcals = getGoogleCalendars();
    if (gcals.length) {
      for (const gc of gcals) {
        calendars.push({
          id: gc.id,
          kind: 'google-sub',
          name: gc.name,
          color: gc.color,
          visible: gc.visible !== false,
          googleId: gc.googleId,
          writeable: true,
        });
      }
    } else {
      calendars.push({
        id: 'gcal_primary',
        kind: 'google-sub',
        name: tokens.google.email || tokens.google.name || 'Google',
        color: providers.google.color,
        visible: providers.google.visible !== false,
        googleId: 'primary',
        writeable: true,
      });
    }
  }

  for (const f of getFeeds()) {
    const u = f.url || '';
    const webCalBase = u.includes('calendar.google.com') ? 'google'
      : (u.includes('outlook.office365.com') || u.includes('outlook.office.com') || u.includes('outlook.live.com')) ? 'outlook'
      : null;
    calendars.push({ id: f.id, kind: 'ics', name: f.name, color: f.color, visible: f.visible !== false, webCalBase });
  }

  for (const account of getCaldavAccounts()) {
    for (const cal of (account.calendars || []).filter((c) => c.selected)) {
      calendars.push({
        id: cal.id,
        kind: 'caldav-sub',
        accountId: account.id,
        name: cal.name,
        color: cal.color || '#0891b2',
        visible: cal.visible !== false,
        writeable: true,
      });
    }
  }

  return calendars;
}
