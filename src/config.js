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
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',

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
