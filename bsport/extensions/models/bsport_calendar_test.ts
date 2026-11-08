/** Unit tests for the calendarEvents mapping helpers. */
import { assertEquals } from "jsr:@std/assert@1";
import {
  compactDt,
  isActiveBooking,
  toCalendarEvent,
  venueOf,
} from "./bsport.ts";

Deno.test("cancelled bookings are not active", () => {
  // Shapes from the live listing (2026-11-08): cancel sets both fields.
  assertEquals(
    isActiveBooking({
      booking_status_code: 2,
      date_canceled: "2026-11-01T20:05:51.111304+01:00",
      is_deleted: false,
    }),
    false,
  );
  assertEquals(
    isActiveBooking({ booking_status_code: 0, date_canceled: "2026-11-01" }),
    false,
  );
  assertEquals(isActiveBooking({ booking_status_code: 2 }), false);
  assertEquals(isActiveBooking({ is_deleted: true }), false);
  assertEquals(
    isActiveBooking({
      booking_status_code: 0,
      date_canceled: null,
      is_deleted: false,
    }),
    true,
  );
});

const reade = venueOf({
  id: 14671,
  title: "Aqua Hero - Reade Amsterdam Centrum",
  location: {
    address: "283 Overtoom, 1054 HW Amsterdam, Netherlands",
    latitude: 52.3601169,
    longitude: 4.8664171,
  },
})!;

Deno.test("booking maps to local wall-clock event with venue pin", () => {
  assertEquals(
    toCalendarEvent({
      name: "Beginner 2: Basic Swimming",
      dateStart: "2026-11-09T20:00:00+01:00",
      durationMin: 55,
      venue: reade,
      key: "bsport booking 176166545",
      waitlist: false,
    }),
    {
      summary: "Basic Swimming @ Aqua Hero",
      start: "2026-11-09T20:00",
      end: "2026-11-09T20:55",
      location: "Aqua Hero - Reade Amsterdam Centrum",
      locationAddress: "283 Overtoom, 1054 HW Amsterdam, Netherlands",
      lat: 52.3601169,
      lon: 4.8664171,
      description: "bsport booking 176166545",
    },
  );
});

Deno.test("waitlist entry is prefixed and keyed by offer", () => {
  const ev = toCalendarEvent({
    name: "Intermediate: Stroke Development",
    dateStart: "2026-12-14T19:30:00Z",
    durationMin: 55,
    venue: reade,
    key: "bsport waitlist 42",
    waitlist: true,
  });
  assertEquals(ev.summary, "Waitlist: Stroke Development @ Aqua Hero");
  assertEquals([ev.start, ev.end], ["2026-12-14T20:30", "2026-12-14T21:25"]);
});

Deno.test("end crossing midnight rolls the date", () => {
  const ev = toCalendarEvent({
    name: "Late",
    dateStart: "2026-11-09T23:30:00+01:00",
    durationMin: 55,
    key: "bsport booking 1",
    waitlist: false,
  });
  assertEquals(ev.end, "2026-11-10T00:25");
  assertEquals(ev.summary, "Late");
});

Deno.test("compactDt normalises UTC, floating and date-only DTSTART", () => {
  assertEquals(compactDt("20261109T190000Z"), "20261109T200000"); // CET
  assertEquals(compactDt("20260709T180000Z"), "20260709T200000"); // CEST
  assertEquals(compactDt("20261201T201500"), "20261201T201500");
  assertEquals(compactDt("20261201"), "20261201T000000");
});

Deno.test("staleCalendarUids: cancelled, duplicate, renamed, past", async () => {
  const { staleCalendarUids } = await import("./bsport.ts");
  const ev = toCalendarEvent({
    name: "Intermediate: Stroke Development",
    dateStart: "2026-11-16T20:00:00+01:00",
    durationMin: 55,
    venue: reade,
    key: "bsport waitlist 39870031",
    waitlist: true,
  });
  const now = "20261108T220000";
  const cal = [
    // kept: matches key + summary + start (UTC dtstart)
    {
      uid: "keep",
      description: ev.description,
      summary: ev.summary,
      dtstart: "20261116T190000Z",
    },
    // duplicate of the kept one
    {
      uid: "dup",
      description: ev.description,
      summary: ev.summary,
      dtstart: "20261116T190000Z",
    },
    // same key, summary lost its prefix → recreate
    {
      uid: "renamed",
      description: ev.description,
      summary: "Stroke Development @ Aqua Hero",
      dtstart: "20261116T190000Z",
    },
    // cancelled booking
    {
      uid: "cancelled",
      description: "bsport booking 176166545",
      summary: "Basic Swimming @ Aqua Hero",
      dtstart: "20261109T190000Z",
    },
    // past cancelled booking: leave history alone
    {
      uid: "past",
      description: "bsport booking 1",
      summary: "x",
      dtstart: "20261101T190000Z",
    },
    // not ours
    {
      uid: "other",
      description: "Reminder",
      summary: "Training",
      dtstart: "20261111T170000",
    },
  ];
  assertEquals(
    staleCalendarUids([ev], cal, now).sort(),
    ["cancelled", "dup", "renamed"],
  );
});
