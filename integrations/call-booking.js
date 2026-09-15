'use strict';

// Entering Call Booked is a two-step commit with a read-back in between.
//
// Call Booked is the one Pipeline stage that means nothing without a real
// meeting time, and the No Show lifecycle later resolves exactly that time. So
// the meeting time (Leads!U) is written and read back FIRST, and only a
// confirmed time lets the stage (Leads!M) move. Any failure before the stage
// write leaves the lead in the stage it was in.
//
// The drawer used to allow the opposite: its stage chip checked a meeting time
// that had never been saved and refused a value sitting visibly in the input,
// while the booking action wrote the time and the stage in one unverified
// batch.

const CALL_BOOKED_STAGE = 'call_booked';

async function readCell(values, spreadsheetId, range) {
  const response = await values.get({ spreadsheetId, range });
  return String(((response.data.values || [])[0] || [])[0] ?? '');
}

// An expired Google login is not a booking failure: it must reach the route's
// isAuthError handling rather than be reported as "not saved".
function rethrowAuth(error) {
  if (error && error.isAuthError) throw error;
}

/**
 * @param values        a Sheets `spreadsheets.values` client
 * @param meetingAt     canonical UTC ISO string (Date#toISOString form)
 * @returns { ok, code, meetingSaved, stageChanged, meetingAt, error }
 */
async function commitCallBooked({ values, spreadsheetId, sheetName, rowNum, meetingAt }) {
  const ms = new Date(String(meetingAt || '')).getTime();
  if (!rowNum || !Number.isFinite(ms) || new Date(ms).toISOString() !== meetingAt) {
    return { ok: false, code: 'invalid_meeting_time', meetingSaved: false, stageChanged: false,
      error: 'A valid meeting date and time is required.' };
  }
  const meetingRange = `${sheetName}!U${rowNum}`;
  const stageRange = `${sheetName}!M${rowNum}`;

  try {
    await values.update({ spreadsheetId, range: meetingRange, valueInputOption: 'RAW', requestBody: { values: [[meetingAt]] } });
  } catch (error) {
    rethrowAuth(error);
    return { ok: false, code: 'meeting_not_saved', meetingSaved: false, stageChanged: false,
      error: `The meeting time was not saved, so the stage was not changed. ${error.message}` };
  }

  let savedMeeting;
  try {
    savedMeeting = await readCell(values, spreadsheetId, meetingRange);
  } catch (error) {
    rethrowAuth(error);
    return { ok: false, code: 'meeting_not_confirmed', meetingSaved: false, stageChanged: false,
      error: `The meeting time could not be read back, so the stage was not changed. ${error.message}` };
  }
  if (savedMeeting !== meetingAt) {
    return { ok: false, code: 'meeting_not_confirmed', meetingSaved: false, stageChanged: false,
      error: 'The stored meeting time did not match the time entered, so the stage was not changed.' };
  }

  try {
    await values.update({ spreadsheetId, range: stageRange, valueInputOption: 'RAW', requestBody: { values: [[CALL_BOOKED_STAGE]] } });
  } catch (error) {
    rethrowAuth(error);
    return { ok: false, code: 'stage_not_saved', meetingSaved: true, stageChanged: false, meetingAt,
      error: `The meeting time was saved, but the stage could not be changed to Call Booked. ${error.message}` };
  }

  let savedStage;
  try {
    savedStage = await readCell(values, spreadsheetId, stageRange);
  } catch (error) {
    rethrowAuth(error);
    return { ok: false, code: 'stage_not_confirmed', meetingSaved: true, stageChanged: null, meetingAt,
      error: `The meeting time was saved, but the Call Booked stage could not be read back. Reload to check. ${error.message}` };
  }
  if (savedStage !== CALL_BOOKED_STAGE) {
    return { ok: false, code: 'stage_not_confirmed', meetingSaved: true, stageChanged: false, meetingAt,
      error: 'The meeting time was saved, but the stored stage is not Call Booked. Reload to check.' };
  }

  return { ok: true, code: 'committed', meetingSaved: true, stageChanged: true, meetingAt: savedMeeting };
}

module.exports = { CALL_BOOKED_STAGE, commitCallBooked };
