import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as MicrosoftStrategy } from 'passport-microsoft';
import { config, isGoogleConfigured, isMicrosoftConfigured } from './config.js';

// We don't use a database. Instead, each provider's OAuth tokens are written
// straight into the user's session by the verify callbacks below. Passport is
// run with { session: false }, so it never tries to serialize a user — it just
// gives us a clean way to run the OAuth dance.

function stash(req, provider, accessToken, refreshToken, params, profile) {
  req.session.tokens = req.session.tokens || {};
  // expiresInSec tells us roughly when the access token dies, so we can refresh.
  const expiresInSec = params?.expires_in ? Number(params.expires_in) : 3600;
  req.session.tokens[provider] = {
    accessToken,
    refreshToken: refreshToken || req.session.tokens[provider]?.refreshToken,
    expiresAt: Date.now() + expiresInSec * 1000,
    name: profile?.displayName || profile?.name?.givenName || 'Account',
    email:
      profile?.emails?.[0]?.value ||
      profile?._json?.mail ||
      profile?._json?.userPrincipalName ||
      '',
  };
}

if (isMicrosoftConfigured()) {
  passport.use(
    new MicrosoftStrategy(
      {
        clientID: config.microsoft.clientId,
        clientSecret: config.microsoft.clientSecret,
        callbackURL: `${config.baseUrl}/auth/microsoft/callback`,
        tenant: config.microsoft.tenant,
        scope: config.microsoft.scopes,
        passReqToCallback: true,
      },
      (req, accessToken, refreshToken, params, profile, done) => {
        stash(req, 'microsoft', accessToken, refreshToken, params, profile);
        done(null, { provider: 'microsoft' });
      }
    )
  );
}

if (isGoogleConfigured()) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: config.google.clientId,
        clientSecret: config.google.clientSecret,
        callbackURL: `${config.baseUrl}/auth/google/callback`,
        scope: config.google.scopes,
        passReqToCallback: true,
      },
      (req, accessToken, refreshToken, params, profile, done) => {
        stash(req, 'google', accessToken, refreshToken, params, profile);
        done(null, { provider: 'google' });
      }
    )
  );
}

export default passport;
