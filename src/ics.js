import ical from 'node-ical';

// Subscribe to a published .ics feed (Outlook "Publish calendar" or Google
// "Secret address in iCal format") with NO login/OAuth. We fetch the feed,
// parse it, expand recurring events into the requested window, and normalise
// to FullCalendar event objects.

// All-day ICS dates (VALUE=DATE) are parsed as local midnight. Format them
// from local components so toISOString()'s UTC shift can't roll them a day.
function localYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

// Length of an all-day event in calendar days (at least 1). Rounding absorbs
// the ±1 h of a DST change between the two local midnights.
function daySpan(ev) {
  if (!ev.end) return 1;
  return Math.max(1, Math.round((ev.end - ev.start) / 86400000));
}

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function toEvent(ev, feed, start, end, allDay) {
  return {
    id: `ics-${feed.id}-${ev.uid || ''}-${start.toISOString()}`,
    title: ev.summary || '(no title)',
    start: allDay ? localYmd(start) : start.toISOString(),
    end: allDay ? localYmd(end) : end.toISOString(),
    allDay,
    color: feed.color,
    calId: feed.id,
    source: feed.name,
    originalUrl: typeof ev.url === 'string' ? ev.url : ev.url?.val || null,
    location: ev.location || '',
    description: (ev.description || '').trim(),
  };
}

export async function fetchIcsEvents(feed, timeMin, timeMax) {
  const data = await ical.async.fromURL(feed.url);
  const rangeStart = new Date(timeMin);
  const rangeEnd = new Date(timeMax);
  const events = [];

  for (const key of Object.keys(data)) {
    const ev = data[key];
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;

    const allDay = ev.datetype === 'date';

    if (!ev.rrule) {
      const endTime = ev.end || ev.start;
      if (endTime < rangeStart || ev.start > rangeEnd) continue;
      events.push(toEvent(ev, feed, ev.start, ev.end || ev.start, allDay));
      continue;
    }

    // Recurring: node-ical expands the rule in the event's own time zone and
    // applies EXDATEs and RECURRENCE-ID overrides, so wall-clock times and
    // all-day dates hold across DST changes. expandOngoing keeps occurrences
    // that began before the window but still overlap it.
    const instances = ical.expandRecurringEvent(ev, {
      from: rangeStart,
      to: rangeEnd,
      expandOngoing: true,
    });
    for (const inst of instances) {
      // node-ical's end is start + a fixed span in ms, which lands on the
      // wrong date when a 23 h or 25 h DST day falls inside an all-day event.
      // Count the span in calendar days instead.
      const end = allDay ? addDays(inst.start, daySpan(inst.event)) : inst.end;
      events.push(toEvent(inst.event, feed, inst.start, end, allDay));
    }
  }

  return events;
}
