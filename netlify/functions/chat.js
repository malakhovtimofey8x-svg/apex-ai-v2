const DAILY_LIMIT = 250;

   const ipRequests = new Map();

   function getToday() {
     return new Date().toISOString().slice(0, 10);
   }

   function checkRateLimit(ip) {
     const today = getToday();
     const key = `${ip}:${today}`;
     const current = ipRequests.get(key) || 0;

     if (current >= DAILY_LIMIT) {
       return { allowed: false, current, limit: DAILY_LIMIT };
     }

     ipRequests.set(key, current + 1);

     if (ipRequests.size > 10000) {
       const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
       for (const k of ipRequests.keys()) {
         if (k.includes(yesterday)) ipRequests.delete(k);
       }
     }

     return { allowed: true, current: current + 1, limit: DAILY_LIMIT };
   }

   exports.handler = async function (event) {
     const headers = {
       'Access-Control-Allow-Origin': '*',
       'Access-Control-Allow-Headers': 'Content-Type',
       'Access-Control-Allow-Methods': 'POST, OPTIONS',
     };

     if (event.httpMethod === 'OPTIONS') {
       return { statusCode: 200, headers, body: '' };
     }

     if (event.httpMethod !== 'POST') {
       return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
     }

     const ip =
       event.headers['x-forwarded-for']?.split(',')[0].trim() ||
       event.headers['client-ip'] ||
       'unknown';

     const rate = checkRateLimit(ip);
     if (!rate.allowed) {
       return {
         statusCode: 429,
         headers: { ...headers, 'X-RateLimit-Limit': String(DAILY_LIMIT), 'X-RateLimit-Remaining': '0' },
         body: JSON.stringify({
           error: `Daily limit of ${DAILY_LIMIT} prioritizations reached. Resets at midnight UTC.`,
         }),
       };
     }

     const apiKey = process.env.ANTHROPIC_API_KEY;
     if (!apiKey) {
       return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured.' }) };
     }

     try {
       const { messages, model = 'claude-haiku-4-5-20251001', max_tokens = 1000 } = JSON.parse(event.body);

       if (!messages || !Array.isArray(messages)) {
         return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body.' }) };
       }

       const response = await fetch('https://api.anthropic.com/v1/messages', {
         method: 'POST',
         headers: {
           'Content-Type': 'application/json',
           'x-api-key': apiKey,
           'anthropic-version': '2023-06-01',
         },
         body: JSON.stringify({ model, max_tokens, messages }),
       });

       const data = await response.json();

       if (!response.ok) {
         return {
           statusCode: response.status,
           headers,
           body: JSON.stringify({ error: data.error?.message || 'Anthropic API error' }),
         };
       }

       return {
         statusCode: 200,
         headers: {
           ...headers,
           'X-RateLimit-Limit': String(DAILY_LIMIT),
           'X-RateLimit-Remaining': String(DAILY_LIMIT - rate.current),
         },
         body: JSON.stringify(data),
       };
     } catch (err) {
       console.error('Proxy error:', err);
       return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error.' }) };
     }
   };
