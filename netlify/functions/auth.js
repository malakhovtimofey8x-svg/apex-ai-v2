exports.handler = async function(event) {
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const APP_URL = process.env.APP_URL || 'https://priovra.netlify.app';
  const REDIRECT_URI = APP_URL + '/.netlify/functions/auth';

  const params = event.queryStringParameters || {};

  // Step 1: Redirect to Google OAuth
  if (params.action === 'login') {
    const scope = encodeURIComponent('https://www.googleapis.com/auth/calendar');
    const url = 'https://accounts.google.com/o/oauth2/v2/auth' +
      '?client_id=' + CLIENT_ID +
      '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
      '&response_type=code' +
      '&scope=' + scope +
      '&access_type=offline' +
      '&prompt=consent' +
      '&state=priovra';
    return { statusCode: 302, headers: { Location: url }, body: '' };
  }

  // Step 2: Handle OAuth callback — exchange code for tokens
  if (params.code) {
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: params.code,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code'
        }).toString()
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok) throw new Error(tokens.error_description || 'Token exchange failed');

      // Store tokens in secure httpOnly cookie (expires 30 days)
      const cookieVal = Buffer.from(JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry: Date.now() + (tokens.expires_in * 1000)
      })).toString('base64');

      const secure = APP_URL.startsWith('https');
      const cookie = 'priovra_gcal=' + cookieVal +
        '; HttpOnly; Path=/; Max-Age=2592000' +
        (secure ? '; Secure; SameSite=Lax' : '');

      return {
        statusCode: 302,
        headers: { Location: APP_URL + '/?cal=connected', 'Set-Cookie': cookie },
        body: ''
      };
    } catch(e) {
      return { statusCode: 302, headers: { Location: APP_URL + '/?cal=error&msg=' + encodeURIComponent(e.message) }, body: '' };
    }
  }

  // Disconnect — clear cookie
  if (params.action === 'logout') {
    return {
      statusCode: 302,
      headers: {
        Location: APP_URL + '/?cal=disconnected',
        'Set-Cookie': 'priovra_gcal=; HttpOnly; Path=/; Max-Age=0'
      },
      body: ''
    };
  }

  return { statusCode: 400, body: 'Bad request' };
};
