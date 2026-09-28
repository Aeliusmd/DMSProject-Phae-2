/** Local calendar date as YYYY-MM-DD (for date inputs). */
export function getTodayInputDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

/** Local datetime as YYYY-MM-DDTHH:mm for datetime-local inputs. */
export function toDateTimeLocalValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Human display for a datetime-local value (avoids showing the raw `T` separator). */
export function formatDateTimeLocalDisplay(value) {
  if (!value) return "";

  const trimmed = String(value).trim();
  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/
  );

  let date;
  if (match) {
    const [, year, month, day, hour, minute, second = "0"] = match;
    date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
  } else {
    date = new Date(trimmed);
  }

  if (Number.isNaN(date.getTime())) return trimmed;

  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/** Convert a UTC instant (ISO / MySQL) into a datetime-local input value in the browser timezone. */
export function utcIsoToDateTimeLocal(value) {
  if (!value) return "";

  const trimmed = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  let parsed;
  if (value instanceof Date) {
    parsed = value;
  } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)) {
    parsed = new Date(`${trimmed.replace(" ", "T")}Z`);
  } else {
    parsed = new Date(trimmed);
  }

  if (Number.isNaN(parsed.getTime())) return "";
  return toDateTimeLocalValue(parsed);
}

/** Parse a datetime-local value as a local Date (avoids UTC parsing of YYYY-MM-DDTHH:mm). */
export function parseDateTimeLocal(value) {
  if (!value) return null;

  const trimmed = String(value).trim();
  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/
  );
  if (!match) return null;

  const [, year, month, day, hour, minute, second = "0"] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );

  return Number.isNaN(date.getTime()) ? null : date;
}

/** Earliest selectable future datetime-local value (next minute). */
export function getMinFutureDateTimeLocal() {
  const nextMinute = new Date();
  nextMinute.setSeconds(0, 0);
  nextMinute.setMinutes(nextMinute.getMinutes() + 1);
  return toDateTimeLocalValue(nextMinute);
}

export function isFutureDateTimeLocal(value) {
  const selected = parseDateTimeLocal(value);
  if (!selected) return false;

  const minFuture = new Date();
  minFuture.setSeconds(0, 0);
  minFuture.setMinutes(minFuture.getMinutes() + 1);
  selected.setSeconds(0, 0);

  return selected.getTime() >= minFuture.getTime();
}
