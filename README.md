# Drive Classifier + Receipt Tax Tracker

A Google Apps Script that sorts scanned and emailed documents in Google Drive with the Gemini API, and files receipts by Malaysian (LHDN) tax relief category, logging each one to a Google Sheet.

## What it does

0. **Email import (v5):** finds receipt emails in Gmail and saves them into `Brother`. PDF, JPEG and PNG attachments are saved as-is; emails without one are saved as a PDF snapshot with a From / Subject / Date header.
1. **Sweep:** moves new mobile scans (PDF, JPEG, PNG named `Scan...`, `Scanned...` or `Receipt...`) from My Drive root into a staging folder called `Brother`.
2. **Classify:** sends each file to Gemini, which returns the category, vendor, title, date, amount, currency, item summary and tax relief subcategory as structured JSON.
3. **Rename:** `Vendor - Title-YYYY-MM-DD-HHmm-XXXX.ext` (XXXX = last 4 characters of the file ID, so names stay unique).
4. **Route:**
   - Claimable receipts go to `<Tax folder>/YA<year>/<relief folder>` (12 relief folders, from `01_Lifestyle` to `12_Donations`).
   - Non-claimable receipts go to `[Automated.DNR] Receipts/<year>/` under Employment Reimbursements, Major Assets and Warranties, or General and Non-Deductible.
   - Letters, documents and manuals go to their own `[Automated.DNR]` folders.
5. **Log:** every receipt gets a row in the `Receipt Tax Tracker` sheet (YA, date, vendor, items, currency, amount, relief category, notes, link, file ID). The file ID prevents duplicate rows. Partial claims are flagged in Notes (for example, mobile phone plans: "claim data portion only").

## Email import

- **Search:** emails mentioning `receipt`, `invoice` or `resit` since `EMAIL_START_DATE`, leaving out Promotions, Social and chats. Once the backlog is cleared, only the last `EMAIL_RESCAN_DAYS` (45) days are checked.
- **No repeats, message by message:** every email message handled gets a row in the **Email Import Log** tab of the tracker sheet (status, files saved, content hashes). A new receipt that lands in an old Gmail conversation is still picked up. Gmail labels (`Receipt-Imported`, `Receipt-Failed`, `Receipt-Skipped`) are added for visibility only.
- **No double-logging:** identical attachments are saved once (content hash), and a forward of a receipt that is already in the same conversation is skipped.
- **Daily cap:** at most `EMAIL_MAX_FILES_PER_DAY` (40) files per day, so a large backlog can't use up the daily Gemini quota. Phone scans are always classified before email imports.
- **Failures emailed to you:** files over 10 MB, image-only emails and conversion errors are listed in a notification email with a link to each message. To retry, delete the email's row in the Email Import Log tab. Print-restricted PDFs are passed through with a note.
- **Junk filters:** `EMAIL_EXCLUDE_SUBJECT_WORDS`, `EMAIL_EXCLUDE_SENDERS`, and emails you sent yourself (forwards with `Fwd:` still count).
- **Dry run:** `testEmailSearch()` lists up to 50 emails that would be handled, without saving, labelling or creating anything.

## Health checks

- **Setup problems pause the run instead of failing files:** a rejected API key, access denied (401/403), `FAILED_PRECONDITION`, every model returning 404, the same Gemini error hitting 3 different files in one run, or a missing API key or source folder. Files stay in `Brother`, no failure is counted against them, and you get at most one alert email per day.
- **Weekly summary email (heartbeat):** sent from the normal trigger every 7 days with health status, last successful run, last file classified, receipts logged (claimable total in MYR), email import counts, and files waiting. If it stops arriving, the trigger has stopped. It warns when runs succeed but nothing has been classified for over 24 hours (for example a Gemini outage).
- **Blank sheet rows:** rows with a File ID but no vendor, amount or link don't block a receipt from being logged again. `cleanupBlankTrackerRows()` removes them.

## Reliability features

- Script lock, so two runs never overlap
- Per-file error isolation: one bad file can't stop the run
- The sheet row is written before the file is moved, so no receipt is lost
- Deadline guard that stays under the 6-minute Apps Script limit
- Model fallback (a model that returns 404 is skipped for the rest of the run), plus retries on 429 and 503 errors
- Daily-quota detection pauses the script until the quota resets
- Failure counter: a file is moved to `[Automated.DNR] Failed` after 3 failed attempts
- Date sanity checks: invalid, future or very old dates fall back to the scan date (or the email's date for email imports), and DD/MM swaps are fixed and flagged
- Formula-injection guard on sheet cells
- Email notice only when something needs review

## Setup

1. Create a new Apps Script project at script.google.com and paste in `drive-classifier.gs`.
2. Get a Gemini API key from Google AI Studio. The paid tier is recommended, since free-tier data may be used to improve Google products.
3. In **Project Settings → Script Properties**, add `GEMINI_API_KEY` with your key.
4. In the code, set `TAX_ROOT_FOLDER_ID` to the ID of the folder that holds your `YA<year>` folders.
5. Create the source folder `Brother` in My Drive root, plus the `[Automated.DNR]` target folders.
6. Set `EMAIL_START_DATE`, then run `testEmailSearch` to approve permissions and preview the matches. Add junk senders or subject words to the exclude lists if needed (set `EMAIL_IMPORT_ENABLED = false` to turn email import off).
7. Run `processBrotherFolderFiles` once by hand. It creates the `Receipt Tax Tracker` sheet (with the `Receipts` and `Email Import Log` tabs) and sends the first weekly summary as confirmation.
8. Add one time-driven trigger on `processBrotherFolderFiles` (every 2 hours works well). Each run imports emails, classifies, then sends the weekly summary when due.

Manual helpers: `importEmailReceipts()` (import only), `sendWeeklySummaryNow()`, `cleanupBlankTrackerRows()`.

## Cost control

- Set a Google Cloud budget alert (for example, USD 5 per month).
- Set a daily request cap on the Generative Language API. This is the actual hard stop on spending.
- `MAX_OUTPUT_TOKENS`, low thinking mode and a 10 MB file limit keep the cost per file low.

## Notes

- The tax relief mapping is a suggestion, not tax advice. Relief rules and limits change every year, so check against LHDN guidance before filing.
- Never commit your API key. It belongs in Script Properties only.
- Optional: use Google's `clasp` CLI to sync this repo with Apps Script.

## License

MIT
