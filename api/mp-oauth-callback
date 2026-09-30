// api/mp-oauth-callback.js
// Receives the OAuth code from Mercado Pago after venue authorizes.
// Exchanges code for access_token + refresh_token.
// Stores tokens in venue table (creates venue row if needed).
// Returns an HTML page that closes itself and notifies the parent window.

const { query } = require('../lib/db');

module.exports = async function handler(req, res) {
  const { code, state, error } = req.query || {};

  // ── Error from MP ─────────────────────────────────────────
  if (error) {
    return res.status(200).send(closePage({
      ok: false,
      message: 'MP rechazó la autorización: ' + error,
    }));
  }

  if (!code) {
    return res.status(200).send(closePage({
      ok: false,
      message: 'No se recibió el código de autorización.',
    }));
  }

  try {
    // ── Exchange code for tokens ───────────────────────────
    const clientId     = process.env.MP_CLIENT_ID;
    const clientSecret = process.env.MP_CLIENT_SECRET;
    const baseUrl      = process.env.PUBLIC_BASE_URL;
    const redirectUri  = baseUrl.replace(/\/+$/, '') + '/mp-connect';

    const tokenRes = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    'authorization_code',
        code:          code,
        redirect_uri:  redirectUri,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[mp-oauth] token exchange failed', tokenData);
      return res.status(200).send(closePage({
        ok: false,
        message: 'Error al obtener el token: ' + (tokenData.message || tokenRes.status),
      }));
    }

    const {
      access_token,
      refresh_token,
      expires_in,
      user_id,
    } = tokenData;

    // Token expires_in is in seconds
    const expiresAt = new Date(Date.now() + (expires_in || 21600) * 1000).toISOString();

    // ── Get MP account info ────────────────────────────────
    // Fetch the venue's MP user info to get their email/name
    const meRes  = await fetch('https://api.mercadopago.com/v1/account/user', {
      headers: { 'Authorization': 'Bearer ' + access_token },
    });
    const meData = meRes.ok ? await meRes.json() : {};

    const mpUserId   = String(user_id || meData.id || '');
    const mpEmail    = meData.email || '';
    const mpNickname = meData.nickname || '';

    // ── state carries the venue slug (set by the wizard) ──
    // Format: "venue_slug:session_id" or just "session_id"
    const stateStr  = String(state || '');
    const venueSlug = stateStr.split(':')[0] || 'chamico'; // default chamico for now

    // ── Upsert venue MP credentials ────────────────────────
    // Update existing venue or create a minimal one if it doesn't exist
    await query(
      `INSERT INTO venue (id, slug, name, city, mp_user_id, mp_access_token, mp_refresh_token, mp_token_expires_at, mp_connected_at)
       VALUES ($1, $2, $3, 'San Antonio de Areco', $4, $5, $6, $7, now())
       ON CONFLICT (id) DO UPDATE SET
         mp_user_id          = EXCLUDED.mp_user_id,
         mp_access_token     = EXCLUDED.mp_access_token,
         mp_refresh_token    = EXCLUDED.mp_refresh_token,
         mp_token_expires_at = EXCLUDED.mp_token_expires_at,
         mp_connected_at     = now()`,
      [venueSlug, venueSlug, mpNickname || venueSlug, mpUserId,
       access_token, refresh_token || null, expiresAt]
    );

    console.log('[mp-oauth] connected venue:', venueSlug, 'mp_user:', mpUserId);

    return res.status(200).send(closePage({
      ok:      true,
      state:   stateStr,
      venueId: venueSlug,
      mpEmail: mpEmail,
      message: '¡Cuenta conectada correctamente!',
    }));

  } catch (err) {
    console.error('[mp-oauth] error', err);
    return res.status(200).send(closePage({
      ok: false,
      message: 'Error interno: ' + err.message,
    }));
  }
};

// ── HTML page that closes the popup and notifies the opener ──
function closePage({ ok, state, venueId, mpEmail, message }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${ok ? 'Conectado ✓' : 'Error'} · DataManIAcs</title>
<style>
  body{background:#0e0d0b;color:#f2ead8;font-family:Inter,sans-serif;
       display:flex;align-items:center;justify-content:center;
       min-height:100vh;margin:0;text-align:center;padding:20px}
  .box{max-width:360px}
  .icon{font-size:48px;margin-bottom:16px}
  h2{font-family:'Playfair Display',serif;font-size:24px;margin-bottom:8px;
     color:${ok ? '#c9a84c' : '#c05a4a'}}
  p{color:#6b6150;font-size:14px;line-height:1.6}
</style>
</head>
<body>
<div class="box">
  <div class="icon">${ok ? '✅' : '❌'}</div>
  <h2>${ok ? '¡Cuenta conectada!' : 'Error de conexión'}</h2>
  <p>${message}</p>
  ${ok ? `<p style="color:#c9a84c;margin-top:8px">${mpEmail}</p>` : ''}
  <p style="margin-top:16px;font-size:12px;color:#4a4035">Esta ventana se cerrará automáticamente…</p>
</div>
<script>
  // Post result to parent window (the eventos page wizard)
  try {
    window.opener && window.opener.postMessage({
      type: 'mp_oauth_result',
      ok:   ${ok},
      state: ${JSON.stringify(state || '')},
      venueId: ${JSON.stringify(venueId || '')},
      mpEmail: ${JSON.stringify(mpEmail || '')},
    }, '*');
  } catch(e) {}
  // Close this popup after a short delay
  setTimeout(() => { try { window.close(); } catch(e) {} }, 2000);
</script>
</body>
</html>`;
}
