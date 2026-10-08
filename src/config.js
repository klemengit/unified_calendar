import dotenv from 'dotenv';

dotenv.config();

const required = (name) => {
  const value = process.env[name];
  if (!value || value.startsWith('your-') || value.includes('change-me')) {
    return undefined; // treated as "not configured" so we can warn nicely
  }
  return value;
};

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  // Loopback by default. This app has no authentication unless AUTH_PASSWORD is set, and
  // data/settings.json always holds OAuth refresh tokens in plaintext — and the CalDAV
  // password too, on a machine with no system keyring to hold it instead (see secrets.js)
  // — so listening on every interface would put a personal calendar on the local network
  // for anyone who can reach the port. Set HOST=0.0.0.0 deliberately, behind something
  // that authenticates — see README, "Reaching it from another machine".
  host: process.env.HOST || '127.0.0.1',
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  authPassword: process.env.AUTH_PASSWORD || null,

  microsoft: {
    clientId: required('MICROSOFT_CLIENT_ID'),
    clientSecret: required('MICROSOFT_CLIENT_SECRET'),
    tenant: process.env.MICROSOFT_TENANT || 'common',
    // Calendars.Read = read events; offline_access = get a refresh token.
    scopes: ['openid', 'profile', 'offline_access', 'User.Read', 'Calendars.Read'],
  },

  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    scopes: [
      'profile',
      'email',
      'https://www.googleapis.com/auth/calendar',
    ],
  },
};

export const isMicrosoftConfigured = () =>
  Boolean(config.microsoft.clientId && config.microsoft.clientSecret);

export const isGoogleConfigured = () =>
  Boolean(config.google.clientId && config.google.clientSecret);
