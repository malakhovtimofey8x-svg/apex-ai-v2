const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const APP_URL = process.env.APP_URL || 'https://priovra.netlify.app';

function parseCookie(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((acc, c) => {
    const [k, ...v] = c.trim().split('=');
    acc[k] = v.join('=');
    return acc;
  }, {});
}

async function getValidToken(cookieHeader) {
  const cookies = parseCookie(cookieHeader);
  const raw = cookies['priovra_gcal'];
  if (!raw) return null;
  try {
    const data = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    // Refresh if expired or expiring in 5 min
    if (Date.now() > data.expiry - 300000 && data.refresh_token) {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: data.refresh_token,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'refresh_token'
        }).toString()
      });
      const refreshed = await res.json();
      if (refreshed.access_token) {
        data.access_token = refreshed.access_token;
        data.expiry = Date.now() + (refreshed.expires_in * 1000);
      }
    }
    return data.access_token;
  } catch(e) { return null; }
}

async function fetchCalendarEvents(token, daysAhead) {
  daysAhead = daysAhead || 14;
  const now = new Date();
  const end = new Date(now.getTime() + daysAhead * 86400000);
  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events' +
    '?timeMin=' + now.toISOString() +
    '&timeMax=' + end.toISOString() +
    '&singleEvents=true' +
    '&orderBy=startTime' +
    '&maxResults=100';
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  return data.items || [];
}

async function createCalendarEvent(token, event) {
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });
  return res.json();
}

async function updateCalendarEvent(token, eventId, event) {
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/' + eventId, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });
  return res.json();
}

async function deleteCalendarEvent(token, eventId) {
  await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/' + eventId, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + token }
  });
  return { deleted: true };
}

function buildFreeSlots(events, daysAhead) {
  daysAhead = daysAhead || 7;
  const slots = [];
  const now = new Date();
  // Work hours: 8am - 10pm
  for (let d = 0; d < daysAhead; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    const dayStr = day.toDateString();
    const dayEvents = events.filter(e => {
      const start = new Date((e.start && (e.start.dateTime || e.start.date)) || '');
      return start.toDateString() === dayStr;
    }).sort((a,b) => new Date(a.start.dateTime||a.start.date) - new Date(b.start.dateTime||b.start.date));

    // Build free windows between 8am-10pm
    const workStart = new Date(day); workStart.setHours(8,0,0,0);
    const workEnd = new Date(day); workEnd.setHours(22,0,0,0);
    let cursor = d === 0 ? new Date(Math.max(now.getTime(), workStart.getTime())) : workStart;

    dayEvents.forEach(e => {
      const eStart = new Date(e.start.dateTime || e.start.date);
      const eEnd = new Date(e.end.dateTime || e.end.date);
      if (eStart > cursor && eStart < workEnd) {
        const gapMins = Math.round((eStart - cursor) / 60000);
        if (gapMins >= 30) {
          slots.push({ start: cursor.toISOString(), end: eStart.toISOString(), durationMins: gapMins, day: dayStr });
        }
      }
      if (eEnd > cursor) cursor = eEnd;
    });
    if (cursor < workEnd) {
      const gapMins = Math.round((workEnd - cursor) / 60000);
      if (gapMins >= 30) slots.push({ start: cursor.toISOString(), end: workEnd.toISOString(), durationMins: gapMins, day: dayStr });
    }
  }
  return slots;
}

async function getAISuggestion(task, events, freeSlots, anthropicKey) {
  const eventSummary = events.slice(0,20).map(e =>
    (e.start.dateTime || e.start.date).slice(0,16) + ' - ' + (e.end.dateTime || e.end.date).slice(0,16) + ': ' + (e.summary || 'Busy')
  ).join('\n');
  const slotSummary = freeSlots.slice(0,10).map(s =>
    s.start.slice(0,16) + ' (' + s.durationMins + ' min free)'
  ).join('\n');

  const prompt = 'You are a smart scheduling assistant. A user needs to schedule this task:\n' +
    'Task: "' + task.name + '"\n' +
    'Priority score: ' + Math.round(task.priority_score) + '\n' +
    'Estimated time: ' + (task.timeEstimate || '1-2 hours') + '\n' +
    (task.dueDate ? 'Due: ' + task.dueDate + '\n' : '') +
    '\nUpcoming calendar events:\n' + eventSummary +
    '\n\nFree time slots:\n' + slotSummary +
    '\n\nReturn ONLY valid JSON, no markdown:\n' +
    '{"best_slot":{"start":"2024-01-15T09:00:00","end":"2024-01-15T11:00:00","reason":"Why this slot is ideal"},' +
    '"alternative_slots":[{"start":"...","end":"...","reason":"..."}],' +
    '"scheduling_tip":"One sentence of advice for this specific task",' +
    '"calendar_title":"Short event title for calendar",' +
    '"calendar_description":"Brief event description"}';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await res.json();
  const text = data.content.map(i => i.text || '').join('');
  return JSON.parse(text.replace(/```json|```/g,'').trim());
}

function generateICS(events) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Priovra//AI Task Operator//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Priovra Tasks',
    'X-WR-TIMEZONE:UTC'
  ];
  events.forEach(e => {
    const start = e.start.dateTime || e.start.date;
    const end = e.end.dateTime || e.end.date;
    const toICS = (iso) => iso.replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z').slice(0,15) + 'Z';
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + (e.id || Math.random().toString(36).slice(2)) + '@priovra.app');
    lines.push('DTSTAMP:' + toICS(new Date().toISOString()));
    lines.push('DTSTART:' + toICS(start));
    lines.push('DTEND:' + toICS(end));
    lines.push('SUMMARY:' + (e.summary || 'Task').replace(/\n/g,' '));
    if (e.description) lines.push('DESCRIPTION:' + e.description.replace(/\n/g,'\\n').slice(0,500));
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const cookieHeader = event.headers.cookie || event.headers.Cookie || '';
  const token = await getValidToken(cookieHeader);

  // Check auth status
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    if (params.action === 'status') {
      return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ connected: !!token }) };
    }
    // Export iCal
    if (params.action === 'ical' && token) {
      const events = await fetchCalendarEvents(token, 30);
      const ics = generateICS(events);
      return { statusCode: 200, headers: { ...headers, 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="priovra.ics"' }, body: ics };
    }
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not connected' }) };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };

  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not connected to Google Calendar' }) };

  const body = JSON.parse(event.body || '{}');
  const action = body.action;

  try {
    // Fetch events
    if (action === 'fetch') {
      const events = await fetchCalendarEvents(token, body.days || 14);
      const freeSlots = buildFreeSlots(events, body.days || 7);
      return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ events, freeSlots }) };
    }

    // AI scheduling suggestion for a task
    if (action === 'suggest') {
      const events = await fetchCalendarEvents(token, 14);
      const freeSlots = buildFreeSlots(events, 7);
      const suggestion = await getAISuggestion(body.task, events, freeSlots, process.env.ANTHROPIC_API_KEY);
      return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ suggestion, freeSlots }) };
    }

    // Create calendar event
    if (action === 'create') {
      const created = await createCalendarEvent(token, body.event);
      return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(created) };
    }

    // Update calendar event
    if (action === 'update') {
      const updated = await updateCalendarEvent(token, body.eventId, body.event);
      return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(updated) };
    }

    // Delete calendar event
    if (action === 'delete') {
      const result = await deleteCalendarEvent(token, body.eventId);
      return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch(e) {
    console.error('Calendar error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
