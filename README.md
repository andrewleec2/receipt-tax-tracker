# Drive Classifier + Receipt Tax Tracker

A Google Apps Script that sorts scanned documents in Google Drive with the Gemini API, and files receipts by Malaysian (LHDN) tax relief category, logging each one to a Google Sheet.

## What it does

1. **Sweep:** moves new mobile scans (PDF, JPEG, PNG named `Scan...`, `Scanned...` or `Receipt...`) from My Drive root into a staging folder called `Brother`.
2. **Classify:** sends each file to Gemini, which returns the category, vendor, title, date, amount, currency, item summary and tax relief subcategory as structured JSON.
3. **Rename:** `Vendor - Title-YYYY-MM-DD-HHmm-XXXX.ext` (XXXX = last 4 characters of the file ID, so names stay unique).
4. **Route:**
   - Claimable receipts go to `<Tax folder>/YA<year>/<relief folder>` (12 relief folders, from `01_Lifestyle` to `12_Donations`).
   - Non-claimable receipts go to `[Automated.DNR] Receipts/<year>/` under Employment Reimbursements, Major Assets and Warranties, or General and Non-Deductible.
   - Letters, documents and manuals go to their own `[Automated.DNR]` folders.
5. **Log:** every receipt gets a row in the `Receipt Tax Tracker` sheet (YA, date, vendor, items, currency, amount, relief category, notes, link, file ID). The file ID prevents duplicate rows.

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
7. Add a time-driven trigger on `processBrotherFolderFiles`.

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
