// Dates come out of SQLite either as date-only strings ("2026-07-31") or as
// space-separated datetimes ("2026-07-31 10:00:00"), and every date the app
// writes is a local calendar day (see formatDbDate).
//
// They must therefore be read back as LOCAL time. Handing a bare "YYYY-MM-DD"
// to `new Date` parses it as UTC midnight, which for anyone east of UTC lands
// several hours into the day — enough to push a row dated today past a range
// end built from local midnight, making same-day entries vanish from charts.
// Appending an explicit time forces local parsing.
const pad = (value: number) => value.toString().padStart(2, '0');

// Writes a Date as the LOCAL calendar day it represents. Never use
// toISOString() here — that converts to UTC first and shifts the day for
// anyone east of UTC. Pairs with parseDbDate on the way back out.
export const formatDbDate = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const parseDbDate = (rawDate: string | Date): Date => {
  if (rawDate instanceof Date) {
    return rawDate;
  }

  const dateText = String(rawDate).trim();
  const [datePart, timePart] = dateText.split(/[ T]/);
  const parsedDate = new Date(`${datePart}T${timePart || '00:00:00'}`);

  return Number.isNaN(parsedDate.getTime()) ? new Date(rawDate) : parsedDate;
};

// Local midnight on the same calendar day. Use for the lower bound of a range.
export const startOfDbDate = (rawDate: string | Date): Date => {
  const parsedDate = parseDbDate(rawDate);
  return new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate());
};

// Last instant of the same calendar day. Use for the upper bound of a range so
// that entries dated on the end day are included rather than sitting exactly on
// the boundary.
export const endOfDbDate = (rawDate: string | Date): Date => {
  const parsedDate = parseDbDate(rawDate);
  return new Date(
    parsedDate.getFullYear(),
    parsedDate.getMonth(),
    parsedDate.getDate(),
    23,
    59,
    59,
    999
  );
};
