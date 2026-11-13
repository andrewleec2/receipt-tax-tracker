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

- **Search:** emails mentioning `receipt`, `invoice` or `resit` since `EMAIL_START_DATE`, leaving out Promotions, Social and chats.
- **No repeats:** each handled thread is labelled `Receipt-Imported`, `Receipt-Failed` or `Receipt-Skipped`, and labelled threads are left out of later searches. Labels are added only after the file is saved.
- **Failures emailed to you:** password-protected PDFs, files over 10 MB, image-only emails and conversion errors are labelled `Receipt-Failed` and listed in a notification email with a link to each message. Remove the label to retry.
- **Junk filters:** `EMAIL_EXCLUDE_SUBJECT_WORDS`, `EMAIL_EXCLUDE_SENDERS`, and emails you sent yourself (forwards with `Fwd:` still count).
- **Dry run:** `testEmailSearch()` lists what would be imported without saving or labelling anything.

## Reliability features

- Script lock, so two runs never overlap
- Per-file error isolation: one bad file can't stop the run
- The sheet row is written before the file is moved, so no receipt is lost
- Deadline guard that stays under the 6-minute Apps Script limit
- Model fallback, plus retries on 429 and 503 errors
- Daily-quota detection pauses the script until the quota resets
- Failure counter: a file is moved to `[Automated.DNR] Failed` after 3 failed attempts
- Date sanity checks: invalid, future or very old dates fall back to the scan date, and DD/MM swaps are fixed and flagged
- Formula-injection guard on sheet cells
- Email notice only when something needs review

## Setup

1. Create a new Apps Script project at script.google.com and paste in `drive-classifier.gs`.
2. Get a Gemini API key from Google AI Studio. The paid tier is recommended, since free-tier data may be used to improve Google products.
3. In **Project Settings → Script Properties**, add `GEMINI_API_KEY` with your key.
4. In the code, set `TAX_ROOT_FOLDER_ID` to the ID of the folder that holds your `YA<year>` folders.
5. Create the source folder `Brother` in My Drive root, plus the `[Automated.DNR]` target folders.
6. Run `testTrackerSheet` once to approve permissions and create the sheet.
7. Set `EMAIL_START_DATE`, then run `testEmailSearch` to approve Gmail access and check the matches. Add junk senders or subject words to the exclude lists if needed (set `EMAIL_IMPORT_ENABLED = false` to turn email import off).
8. Add one time-driven trigger on `processBrotherFolderFiles` (every 2 hours works well). Each run imports emails first, then classifies.

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
