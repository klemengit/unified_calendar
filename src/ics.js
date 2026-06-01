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
    const durationMs =
      ev.end && ev.start ? ev.end.getTime() - ev.start.getTime() : 0;

    if (!ev.rrule) {
      const endTime = ev.end || ev.start;
      if (endTime < rangeStart || ev.start > rangeEnd) continue;
      events.push(toEvent(ev, feed, ev.start, ev.end || ev.start, allDay));
      continue;
    }

    // Recurring: ask the rrule for occurrences in the window (pad the start by
    // the event duration so events that began earlier but overlap still show).
    const occurrences = ev.rrule.between(
      new Date(rangeStart.getTime() - durationMs),
      rangeEnd,
      true
    );

    for (const occ of occurrences) {
      const dateKey = occ.toISOString().slice(0, 10);

      // Skip dates explicitly removed from the series.
      if (ev.exdate && ev.exdate[dateKey]) continue;

      // Use the override if this occurrence was individually edited.
      const override = ev.recurrences && ev.recurrences[dateKey];
      if (override) {
        events.push(
          toEvent(override, feed, override.start, override.end || override.start, allDay)
        );
        continue;
      }

      const start = occ;
      const end = new Date(occ.getTime() + durationMs);
      events.push(toEvent(ev, feed, start, end, allDay));
    }
  }

  return events;
}
