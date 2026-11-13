// =========================================================
// DRIVE CLASSIFIER + RECEIPT TAX TRACKER  (v6)
// v6: setup problems (bad API key, retired model names, missing folder) pause the
//     run and email you once a day, instead of failing every file;
//     blank sheet rows no longer block re-logging (plus cleanupBlankTrackerRows);
//     weekly summary email doubles as a heartbeat (no email = check the trigger)
//     After independent review: each email MESSAGE is tracked in an "Email Import Log"
//     tab (new receipts in old Gmail conversations are no longer missed); identical
//     attachments are saved once (no double-logged forwards); daily email import cap;
//     same Gemini error on 3 files = setup problem; scans are classified before
//     email imports; email date used when a receipt's date is unreadable.
// v5: imports receipts from Gmail into Brother before classifying
//     (attachments saved as-is, emails without one saved as a PDF snapshot;
//     failures are emailed to you). See EMAIL RECEIPT IMPORT section.
// v4: claimable receipts go to <Tax folder>/YA<year>/<relief folder>
//     non-claimable receipts stay in [Automated.DNR] Receipts/<year>/05, 06 or 07
//     Folders not in RECEIPT_SUBCATEGORIES (e.g. 13_...) are filed by hand
// Includes all v3 review fixes (lock, try/catch, sheet-before-move, quota,
// date checks, currency, formula guard, trashed-folder checks, cost caps).
// =========================================================


// =========================================================
// CONFIGURATION
// =========================================================
const TZ = 'Asia/Kuala_Lumpur';

// Tries 3.5-flash first, falls back to 3.8-flash on 404/503. Verify names in AI Studio.
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-3.8-flash'];
const SOURCE_FOLDER_NAME = 'Brother';

const RECEIPTS_FOLDER_NAME = '[Automated.DNR] Receipts';
const UNKNOWN_FOLDER_NAME = '[Automated.DNR] Misc Unknown';
const FAILED_FOLDER_NAME = '[Automated.DNR] Failed';

const TARGET_FOLDERS = [
  '[Automated.DNR] Communication Letters',
  '[Automated.DNR] Documents',
  '[Automated.DNR] Product Manual',
  RECEIPTS_FOLDER_NAME,
  UNKNOWN_FOLDER_NAME
];

// Claimable relief folders (must match the folder names inside YA2025 etc.)
// plus three non-claimable codes (NC_...)
const RECEIPT_SUBCATEGORIES = [
  '01_Lifestyle', '02_Sports', '03_Medical_Family', '04_Medical_Parents',
  '05_Childcare', '06_Education_Self', '07_Life_Insurance_EPF',
  '08_Edu_Medical_Insurance', '09_PRS', '10_SSPN', '11_EV_Charging', '12_Donations',
  'NC_Employment_Reimbursements', 'NC_Major_Assets_and_Warranties', 'NC_General_and_Non_Deductible'
];

// Non-claimable codes -> folder names inside [Automated.DNR] Receipts/<year>
const NON_CLAIMABLE_FOLDERS = {
  'NC_Employment_Reimbursements': '05_Employment_Reimbursements',
  'NC_Major_Assets_and_Warranties': '06_Major_Assets_and_Warranties',
  'NC_General_and_Non_Deductible': '07_General_and_Non_Deductible'
};
const DEFAULT_SUBCATEGORY = 'NC_General_and_Non_Deductible';

// The folder that holds YA2025, YA2026 ... (new YA folders are created automatically)
// Replace with your own folder ID (the part after /folders/ in the folder's URL)
const TAX_ROOT_FOLDER_ID = 'YOUR_TAX_FOLDER_ID';

// Timing (paid tier). Your daily request cap in Google Cloud is the real hard stop.
const RATE_LIMIT_DELAY_MS = 1 * 1000;
const MAX_EXECUTION_TIME_MS = 5.0 * 60 * 1000;
const RETRY_WAIT_MS = 15 * 1000;
const MIN_TIME_FOR_CALL_MS = 45 * 1000;
const MAX_ATTEMPTS_PER_MODEL = 2;
const MAX_FAILURES_PER_FILE = 3;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Cost controls
const MAX_OUTPUT_TOKENS = 2048;
const THINKING_CONFIG = { thinkingLevel: 'low' };

const MAX_RECEIPT_AGE_YEARS = 7;

// Receipt tax tracker sheet
const TRACKER_SHEET_NAME = 'Receipt Tax Tracker';
const TRACKER_TAB_NAME = 'Receipts';
const TRACKER_HEADERS = [
  'Logged At', 'Year of Assessment', 'Transaction Date', 'Vendor', 'Item Summary',
  'Currency', 'Amount', 'Relief Subcategory', 'Notes', 'File Name', 'Receipt Link', 'File ID'
];

// Email receipt import (v5, reworked in v6)
const EMAIL_IMPORT_ENABLED = true;                  // set false to switch email import off
const EMAIL_KEYWORDS = ['receipt', 'invoice', 'resit'];
// Never import emails older than this (Malaysia time)
const EMAIL_START_DATE = '2026-01-01T00:00:00+08:00';
const EMAIL_LOG_TAB_NAME = 'Email Import Log';      // one row per email message handled
const EMAIL_PAGE_SIZE = 50;                         // Gmail conversations fetched per page
const EMAIL_MAX_PAGES_PER_RUN = 10;
const EMAIL_RESCAN_DAYS = 45;                       // after the backlog: only look at the last 45 days
const EMAIL_MAX_FILES_PER_DAY = 40;                 // stops a backlog from using up the daily Gemini cap
const EMAIL_IMPORT_BUDGET_MS = 60 * 1000;           // max 1 minute per run, leaves time to classify
const EMAIL_EXTRA_FILTERS = '-category:promotions -category:social -in:chats -subject:"Drive Classifier"';
// Emails whose subject contains any of these are never imported (add more if junk shows up)
const EMAIL_EXCLUDE_SUBJECT_WORDS = ['interview', 'reminder', 'earnings', 'fund transfer', 'welcome',
                                     'shipping confirmation', 'e-wallet reload', 'shared with you'];
// Emails from these senders are never imported. Use a name or an email address/domain.
// Example: ['My Condo Management', 'old-employer.com', 'newsletter@example.com']
const EMAIL_EXCLUDE_SENDERS = [];
// Gmail labels are for you to see what happened. The Email Import Log decides what is skipped.
const EMAIL_IMPORTED_LABEL = 'Receipt-Imported';    // saved to Brother
const EMAIL_FAILED_LABEL = 'Receipt-Failed';        // needs you; you get an email about it
const EMAIL_SKIPPED_LABEL = 'Receipt-Skipped';      // matched the search but nothing to save
const EMAIL_MIN_IMAGE_BYTES = 15 * 1024;            // smaller images are usually logos or signatures
const EMAIL_MIN_BODY_CHARS = 40;                    // less text than this = image-only email

// Health checks (v6)
const SUMMARY_INTERVAL_DAYS = 7;    // weekly summary email; if it stops arriving, check the trigger
const STALE_RUN_HOURS = 24;         // summary warns if the last good run is older than this


// =========================================================
// ENTRY POINT (point your time-based trigger here)
// =========================================================
function processBrotherFolderFiles() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('Another run is still active. Exiting this one.');
    return;
  }
  try {
    const runStart = Date.now();
    // Step 1: pull new email receipts into Brother (errors here never stop classification)
    try {
      importEmailReceipts_(runStart + EMAIL_IMPORT_BUDGET_MS);
    } catch (e) {
      Logger.log('Email import error (classification continues): ' + e);
    }
    // Step 2: classify everything in Brother, including what was just imported
    let classifyError = null;
    try {
      runClassifier_(runStart);
    } catch (e) {
      classifyError = e;
      Logger.log('Classification error: ' + e);
    }
    // Step 3: weekly summary (sent at most once every 7 days)
    try {
      maybeSendWeeklySummary_();
    } catch (e) {
      Logger.log('Weekly summary error: ' + e);
    }
    // Re-throw so Apps Script still records the run as failed and can notify you
    if (classifyError) throw classifyError;
  } finally {
    lock.releaseLock();
  }
}


// =========================================================
// MAIN LOGIC
// =========================================================
function runClassifier_(runStart) {
  RETIRED_MODELS_ = {};   // models found missing (404) are skipped for the rest of this run
  const startTime = runStart || Date.now();
  const deadline = startTime + MAX_EXECUTION_TIME_MS;
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  Logger.log('--- EXECUTION START ---');

  if (!apiKey || apiKey.trim() === '') {
    Logger.log('CRITICAL ERROR: GEMINI_API_KEY is missing in Script Properties. Aborting run.');
    recordRunStatus_(props, 'GEMINI_API_KEY is missing in Script Properties');
    sendSetupAlert_(props, 'GEMINI_API_KEY is missing in Script Properties (Project Settings > Script Properties).');
    return;
  }

  // 1. Find 'Brother' at the Root level
  const rootFolder = DriveApp.getRootFolder();
  const sourceFolder = findChildFolder_(rootFolder, SOURCE_FOLDER_NAME);
  if (!sourceFolder) {
    Logger.log('Source folder "' + SOURCE_FOLDER_NAME + '" not found in Root directory.');
    recordRunStatus_(props, 'Source folder "' + SOURCE_FOLDER_NAME + '" not found');
    sendSetupAlert_(props, 'The "' + SOURCE_FOLDER_NAME + '" folder was not found at the top level of My Drive. ' +
                           'Was it renamed, moved or trashed?');
    return;
  }
  Logger.log('Connected to source folder: ' + sourceFolder.getName() + ' (ID: ' + sourceFolder.getId() + ')');

  // 2. PRE-SWEEP: move mobile scans from My Drive root to Brother
  const rootFiles = rootFolder.searchFiles(
    "trashed = false and (title contains 'Scan' or title contains 'Receipt')"
  );
  const scanRegex = /^(Scanned|Scan|Receipt)([\s\-_]|\d)/i;
  const validMimeTypes = [MimeType.PDF, MimeType.JPEG, MimeType.PNG];
  const oneMinuteAgo = new Date(startTime - 60 * 1000);
  let sweptCount = 0;

  while (rootFiles.hasNext()) {
    if (Date.now() > deadline) {
      Logger.log('Approaching timeout during root sweep. Stopping sweep.');
      break;
    }
    const rootFile = rootFiles.next();
    try {
      if (validMimeTypes.includes(rootFile.getMimeType()) &&
          scanRegex.test(rootFile.getName()) &&
          rootFile.getDateCreated() < oneMinuteAgo) {
        Logger.log('Sweeping mobile scan to Brother folder: ' + rootFile.getName());
        rootFile.moveTo(sourceFolder);
        sweptCount++;
      }
    } catch (e) {
      Logger.log('Could not sweep ' + rootFile.getName() + ': ' + e);
    }
  }
  Logger.log('Root sweep finished. Total loose files swept: ' + sweptCount);

  // 3. QUOTA CHECK: skip API work if today's quota was already used up
  const blockedUntil = Number(props.getProperty('QUOTA_BLOCKED_UNTIL') || 0);
  if (Date.now() < blockedUntil) {
    Logger.log('Daily Gemini quota was reached earlier. Skipping classification until ' +
               Utilities.formatDate(new Date(blockedUntil), TZ, 'yyyy-MM-dd HH:mm') + ' (MYT).');
    recordRunStatus_(props, '');   // healthy, just waiting for the quota to reset
    return;
  }

  cleanupFailCounters_(props, sourceFolder);

  // 4. RESOLVE FOLDERS + OPEN TRACKER SHEET
  const folderCache = {};
  TARGET_FOLDERS.forEach(name => {
    folderCache[name] = resolveFolder_(props, name, false);
    if (!folderCache[name]) Logger.log('WARNING: Target folder not found: ' + name);
  });
  const failedFolder = resolveFolder_(props, FAILED_FOLDER_NAME, true);
  const unknownFolderId = folderCache[UNKNOWN_FOLDER_NAME] ? folderCache[UNKNOWN_FOLDER_NAME].getId() : null;

  let taxRoot = null;
  try {
    taxRoot = DriveApp.getFolderById(TAX_ROOT_FOLDER_ID);
    if (taxRoot.isTrashed()) taxRoot = null;
  } catch (e) {
    taxRoot = null;
  }
  if (!taxRoot) Logger.log('WARNING: Tax folder not found. Claimable receipts will stay in Brother until fixed.');

  const trackerSheet = getTrackerSheet_(props);
  const loggedIds = getLoggedFileIds_(trackerSheet);
  Logger.log('Tracker sheet ready. Receipts already logged: ' + loggedIds.size);

  // 5. PROCESS FILES IN BROTHER
  // Phone scans first, then email imports, so an email backlog can't hold up your scans
  const fileList = [];
  const fileIterator = sourceFolder.getFiles();
  while (fileIterator.hasNext() && fileList.length < 500) {
    const f = fileIterator.next();
    fileList.push({ file: f, fromEmail: /^Receipt_Email_/.test(f.getName()) });
  }
  fileList.sort((a, b) => (a.fromEmail ? 1 : 0) - (b.fromEmail ? 1 : 0));

  let brotherFileCount = 0;
  let apiCallCount = 0;
  let processedCount = 0;
  let unknownFilesCount = 0;
  let failedFilesCount = 0;
  let receiptsLogged = 0;
  let dailyQuotaHit = false;
  let setupProblem = '';
  // Gemini errors are only counted against files at the end of the run, so that
  // if the same error turns out to hit many files (a setup problem), no file is blamed
  const pendingFailures = [];
  const filesPerError = {};

  for (let i = 0; i < fileList.length; i++) {
    if (Date.now() > deadline) {
      Logger.log('Approaching script timeout. Remaining files will process on next run.');
      break;
    }

    const file = fileList[i].file;
    brotherFileCount++;

    try {
      const mimeType = file.getMimeType();
      if (!validMimeTypes.includes(mimeType)) {
        Logger.log('Skipping unsupported MIME type: ' + file.getName() + ' (' + mimeType + ')');
        continue;
      }

      if (file.getSize() > MAX_FILE_BYTES) {
        Logger.log('File too large (' + Math.round(file.getSize() / 1048576) + ' MB). Moving to Failed: ' + file.getName());
        if (moveToFailed_(file, failedFolder)) failedFilesCount++;
        continue;
      }

      if (apiCallCount > 0) Utilities.sleep(RATE_LIMIT_DELAY_MS);
      apiCallCount++;

      Logger.log('Processing file #' + apiCallCount + ': ' + file.getName());
      const result = classifyDocumentWithGemini_(file, deadline, props, apiKey);

      if (result.outOfTime) {
        Logger.log('Not enough time left for a safe API call. Stopping; file stays in Brother.');
        break;
      }
      if (result.systemic) {
        // A setup problem affects every file, so it must never count against this one
        setupProblem = result.reason;
        Logger.log('SETUP PROBLEM: ' + result.reason +
                   ' Stopping run; files stay in Brother and are not counted as failures.');
        break;
      }
      if (result.quotaHit) {
        if (result.daily) {
          const until = Date.now() + msUntilPacificMidnight_();
          props.setProperty('QUOTA_BLOCKED_UNTIL', String(until));
          dailyQuotaHit = true;
          Logger.log('Daily quota reached. Pausing API work until ' +
                     Utilities.formatDate(new Date(until), TZ, 'yyyy-MM-dd HH:mm') + ' (MYT).');
        } else {
          Logger.log('Per-minute rate limit still hit after retry. Stopping run; files stay in Brother.');
        }
        break;
      }
      if (result.transient) {
        Logger.log('Temporary network/server problem. Will retry next run: ' + file.getName());
        continue;
      }
      if (result.permanent) {
        Logger.log('Gemini refused this file (' + result.reason + '). Moving to Failed: ' + file.getName());
        if (moveToFailed_(file, failedFolder)) failedFilesCount++;
        continue;
      }
      if (result.apiError) {
        pendingFailures.push(file);
        Logger.log('API failed for this file (counted at the end of the run): ' + file.getName());
        // Same error on 3 different files = a setup problem, unless the error is about the document itself
        if (result.errorKey && !/document|file|pdf|image|page|mime|password|encrypt|corrupt/i.test(result.errorKey)) {
          filesPerError[result.errorKey] = (filesPerError[result.errorKey] || 0) + 1;
          if (filesPerError[result.errorKey] >= 3) {
            setupProblem = 'The same Gemini error hit 3 different files in one run: ' + result.errorKey;
            Logger.log('SETUP PROBLEM: ' + setupProblem + ' Stopping run; no file is counted as failed.');
            break;
          }
        }
        continue;
      }

      // ---- Success: work out date, year and destination BEFORE touching the file ----
      const fileId = file.getId();
      props.deleteProperty('FAILS_' + fileId);

      const createdDate = file.getDateCreated();
      const scanTimeStr = Utilities.formatDate(createdDate, TZ, 'HHmm');
      // Email imports fall back to the email's date (in the file name), not the import date
      const fallbackDate = emailDateFromName_(file.getName()) || createdDate;
      const dateCheck = validateTransactionDate_(result.transactionDate, fallbackDate);
      const effectiveDateStr = dateCheck.dateStr;
      const documentYear = effectiveDateStr.substring(0, 4);
      if (dateCheck.note) Logger.log('Date note: ' + dateCheck.note);

      let destinationFolder = folderCache[result.category] || folderCache[UNKNOWN_FOLDER_NAME];
      let subCategoryName = '';
      const isReceipt = result.category === RECEIPTS_FOLDER_NAME && !!folderCache[RECEIPTS_FOLDER_NAME];

      if (isReceipt) {
        subCategoryName = RECEIPT_SUBCATEGORIES.includes(result.receiptSubcategory)
          ? result.receiptSubcategory
          : DEFAULT_SUBCATEGORY;

        if (NON_CLAIMABLE_FOLDERS[subCategoryName]) {
          // Non-claimable: [Automated.DNR] Receipts/<year>/<05, 06 or 07 folder>
          const yearFolder = getOrCreateSubfolder_(destinationFolder, documentYear);
          destinationFolder = getOrCreateSubfolder_(yearFolder, NON_CLAIMABLE_FOLDERS[subCategoryName]);
        } else {
          // Claimable: <Tax folder>/YA<year>/<relief folder>
          if (!taxRoot) {
            Logger.log('Tax folder missing. Leaving claimable receipt in Brother: ' + file.getName());
            continue;
          }
          const yaFolder = getOrCreateSubfolder_(taxRoot, 'YA' + documentYear);
          destinationFolder = getOrCreateSubfolder_(yaFolder, subCategoryName);
        }
      }

      if (!destinationFolder) {
        Logger.log('No destination folder available. Leaving file untouched: ' + file.getName());
        continue;
      }

      // ---- Build the new name (File ID tag keeps names unique) ----
      const originalName = file.getName();
      const fileExtension = originalName.includes('.') ? originalName.substring(originalName.lastIndexOf('.')) : '';
      const cleanVendor = result.vendorName.replace(/[\/\\:*?"<>|]/g, '').trim();
      const cleanTitle = result.shortTitle.replace(/[\/\\:*?"<>|]/g, '').trim();
      const titlePrefix = (cleanVendor && cleanVendor.toLowerCase() !== 'unknown' &&
                           !cleanTitle.toLowerCase().includes(cleanVendor.toLowerCase()))
        ? cleanVendor + ' - ' + cleanTitle
        : cleanTitle;
      const idTag = fileId.slice(-4);
      const newFileName = titlePrefix + '-' + effectiveDateStr + '-' + scanTimeStr + '-' + idTag + fileExtension;

      // ---- Log to the sheet FIRST, then rename and move ----
      if (isReceipt && !loggedIds.has(fileId)) {
        trackerSheet.appendRow([
          new Date(),
          'YA ' + documentYear,
          Utilities.parseDate(effectiveDateStr, TZ, 'yyyy-MM-dd'),
          safeCell_(cleanVendor || 'Unknown'),
          safeCell_(result.itemSummary),
          safeCell_(result.currency),
          result.totalAmount,
          subCategoryName,
          safeCell_([dateCheck.note, claimNoteFor_(result, subCategoryName)].filter(Boolean).join('; ')),
          safeCell_(newFileName),
          file.getUrl(),
          safeCell_(fileId)
        ]);
        SpreadsheetApp.flush();
        loggedIds.add(fileId);
        receiptsLogged++;
        Logger.log('Logged receipt to tracker sheet: ' + newFileName);
      }

      file.setName(newFileName);
      Logger.log('Renamed file to: ' + newFileName);
      file.moveTo(destinationFolder);
      processedCount++;
      if (isReceipt) Logger.log('Routed receipt to: ' + documentYear + ' / ' + subCategoryName);
      if (unknownFolderId && destinationFolder.getId() === unknownFolderId) unknownFilesCount++;

    } catch (e) {
      Logger.log('Error while handling ' + safeName_(file) + ': ' + e);
      try {
        if (recordFailure_(props, file, failedFolder)) failedFilesCount++;
      } catch (inner) {
        Logger.log('Could not record failure: ' + inner);
      }
    }
  }

  // Count Gemini failures against their files, unless this run found a setup problem
  if (setupProblem) {
    if (pendingFailures.length) Logger.log('Not counting ' + pendingFailures.length + ' file failure(s): setup problem.');
  } else {
    pendingFailures.forEach(file => {
      try {
        if (recordFailure_(props, file, failedFolder)) {
          failedFilesCount++;
          Logger.log('File failed ' + MAX_FAILURES_PER_FILE + ' times. Moved to Failed: ' + safeName_(file));
        }
      } catch (e) {
        Logger.log('Could not record failure: ' + e);
      }
    });
  }

  Logger.log('Execution complete. Inspected: ' + brotherFileCount +
             ', Processed: ' + processedCount +
             ', Receipts logged: ' + receiptsLogged +
             ', Failed: ' + failedFilesCount);

  if (processedCount > 0) props.setProperty('LAST_CLASSIFY_SUCCESS', String(Date.now()));
  recordRunStatus_(props, setupProblem);
  if (setupProblem) sendSetupAlert_(props, setupProblem);

  // 6. EMAIL NOTICE (only when something needs your attention)
  const email = Session.getEffectiveUser().getEmail();
  if ((unknownFilesCount > 0 || failedFilesCount > 0 || dailyQuotaHit) && email) {
    let body = 'Hello,\n\n';
    if (unknownFilesCount > 0) {
      body += '- ' + unknownFilesCount + ' file(s) were moved to ' + UNKNOWN_FOLDER_NAME + ' and need manual review.\n';
    }
    if (failedFilesCount > 0) {
      body += '- ' + failedFilesCount + ' file(s) were moved to ' + FAILED_FOLDER_NAME + ' and need manual review.\n';
    }
    if (dailyQuotaHit) {
      body += '- The daily Gemini request cap was reached. Remaining files will be processed after the quota resets.\n';
    }
    MailApp.sendEmail(email, 'Drive Classifier Notice: Action Needed', body);
  }
}


// =========================================================
// GEMINI API CALL: fallback models, retries, deadline, quota handling
// =========================================================
function classifyDocumentWithGemini_(file, deadline, props, apiKey) {
  const base64Data = Utilities.base64Encode(file.getBlob().getBytes());
  const mimeType = file.getMimeType();
  let useThinking = !!THINKING_CONFIG && props.getProperty('THINKING_DISABLED') !== 'true';

  let lastStatus = null;
  let sawException = false;
  let notFoundCount = 0;   // models that returned 404

  for (let m = 0; m < GEMINI_MODELS.length; m++) {
    const modelName = GEMINI_MODELS[m];
    if (RETIRED_MODELS_[modelName]) { notFoundCount++; continue; }   // already 404'd this run
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelName + ':generateContent';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      if (Date.now() + MIN_TIME_FOR_CALL_MS > deadline) {
        return { apiError: true, outOfTime: true };
      }
      const isLastAttempt = attempt === MAX_ATTEMPTS_PER_MODEL;
      const canWaitAndRetry = !isLastAttempt && (Date.now() + RETRY_WAIT_MS + MIN_TIME_FOR_CALL_MS < deadline);

      let response;
      try {
        response = UrlFetchApp.fetch(url, buildGeminiRequest_(base64Data, mimeType, apiKey, useThinking));
      } catch (e) {
        sawException = true;
        Logger.log('Network error calling ' + modelName + ' (attempt ' + attempt + '): ' + e);
        if (!isLastAttempt) Utilities.sleep(5 * 1000);
        continue;
      }

      const status = response.getResponseCode();
      const body = response.getContentText();
      lastStatus = status;

      if (status === 200) {
        const parsed = parseGeminiResponse_(body);
        if (parsed.ok) {
          const d = parsed.data;
          const classified = {
            apiError: false,
            category: d.category,
            vendorName: d.vendor_name || 'Unknown',
            shortTitle: d.short_title || 'Document',
            transactionDate: d.transaction_date || 'UNKNOWN',
            receiptSubcategory: d.receipt_subcategory || DEFAULT_SUBCATEGORY,
            totalAmount: typeof d.total_amount === 'number' ? d.total_amount : 0,
            currency: (d.currency || 'MYR').toUpperCase().substring(0, 3),
            itemSummary: d.item_summary || '',
            claimNote: d.claim_note || ''
          };
          return applyRefundRule_(classified);
        }
        if (parsed.permanent) return { apiError: true, permanent: true, reason: parsed.reason };
        Logger.log('Unusable answer from ' + modelName + ' (' + parsed.reason + '), attempt ' + attempt + '.');
        continue;
      }

      if (status === 404) {
        notFoundCount++;
        RETIRED_MODELS_[modelName] = true;
        Logger.log('Model ' + modelName + ' returned 404. Skipping it for the rest of this run...');
        break;
      }

      if (status === 400 && useThinking && /thinking/i.test(body)) {
        Logger.log('Model rejected thinkingConfig. Turning it off for future runs and retrying.');
        props.setProperty('THINKING_DISABLED', 'true');
        useThinking = false;
        attempt--;
        continue;
      }

      // Setup problems: the same error would hit every file, so stop instead of blaming this one
      if (status === 400 && /API_KEY_INVALID|API key not valid|API key expired/i.test(body)) {
        return { apiError: true, systemic: true,
                 reason: 'The Gemini API key was rejected (invalid or expired). Check GEMINI_API_KEY in Script Properties.' };
      }
      if (status === 401 || status === 403) {
        return { apiError: true, systemic: true,
                 reason: 'Gemini refused access [' + status + ']: the API key, billing or the Generative Language API ' +
                         'may be disabled. Details: ' + body.substring(0, 300) };
      }
      if (/FAILED_PRECONDITION/.test(body)) {
        return { apiError: true, systemic: true,
                 reason: 'Gemini returned FAILED_PRECONDITION (often billing or region settings). Details: ' +
                         body.substring(0, 300) };
      }

      if (status === 429) {
        if (/PerDay/i.test(body)) return { apiError: true, quotaHit: true, daily: true };
        if (canWaitAndRetry) {
          Logger.log('Per-minute rate limit (429). Waiting ' + (RETRY_WAIT_MS / 1000) + 's before retry...');
          Utilities.sleep(RETRY_WAIT_MS);
          continue;
        }
        return { apiError: true, quotaHit: true };
      }

      if (status === 503 || status === 500) {
        if (canWaitAndRetry) {
          Logger.log('Model ' + modelName + ' busy [' + status + ']. Waiting ' + (RETRY_WAIT_MS / 1000) + 's before retry...');
          Utilities.sleep(RETRY_WAIT_MS);
          continue;
        }
        break;
      }

      Logger.log('Gemini API Error Status [' + status + ']: ' + body.substring(0, 500));
      // errorKey lets the run spot the same error hitting several files
      let message = '';
      try { message = (JSON.parse(body).error || {}).message || ''; } catch (e) { message = body; }
      return { apiError: true, status: status, errorKey: status + ': ' + String(message).substring(0, 120) };
    }
  }

  if (notFoundCount === GEMINI_MODELS.length) {
    return { apiError: true, systemic: true,
             reason: 'Every model in GEMINI_MODELS returned 404 (not found): ' + GEMINI_MODELS.join(', ') +
                     '. The model names may have been retired. Check the current names in Google AI Studio.' };
  }
  if (lastStatus === 429) return { apiError: true, quotaHit: true };
  if (lastStatus === 503 || lastStatus === 500 || (sawException && lastStatus === null)) {
    return { apiError: true, transient: true };
  }
  return { apiError: true };
}

function buildGeminiRequest_(base64Data, mimeType, apiKey, useThinking) {
  const promptText =
    "You are an automated document classifier and namer for a Malaysian household. Analyze the document and return JSON matching the schema:\n" +
    "1. category: Categorize strictly into one of the permitted target folder names.\n" +
    "2. vendor_name: Extract the primary merchant, clinic, telco, bank, or issuer (1 to 3 words max, e.g., 'Tenaga Nasional', 'Kedai Ubat', 'Popular'). If none, return 'Unknown'.\n" +
    "3. short_title: Concise document type (2 to 3 words max, e.g., 'Payment Receipt', 'Tax Invoice', 'Medical Receipt'). Do not repeat vendor_name or include dates.\n" +
    "4. transaction_date: The actual billing or purchase date printed on the document, returned in 'YYYY-MM-DD' format. Malaysian documents usually print dates as DD/MM/YYYY, so read day before month. If illegible or missing, return 'UNKNOWN'.\n" +
    "5. receipt_subcategory: If category is '[Automated.DNR] Receipts', pick the Malaysian personal tax relief it fits:\n" +
    "   - '01_Lifestyle': books, magazines, newspapers, PCs, smartphones, tablets, internet subscriptions (home fibre/broadband, and mobile phone plans because their data portion is claimable).\n" +
    "   - '02_Sports': sports equipment, gym memberships, sports facility rental, sports competition fees, sports training.\n" +
    "   - '03_Medical_Family': medical treatment, dental, vaccination, full medical exam, health screening or mental health for self, spouse or child.\n" +
    "   - '04_Medical_Parents': medical, dental or care expenses for parents.\n" +
    "   - '05_Childcare': registered kindergarten or childcare centre fees.\n" +
    "   - '06_Education_Self': self-education fees (degree, masters, professional or skills courses).\n" +
    "   - '07_Life_Insurance_EPF': life insurance or takaful premiums, EPF voluntary contributions.\n" +
    "   - '08_Edu_Medical_Insurance': education or medical insurance premiums.\n" +
    "   - '09_PRS': Private Retirement Scheme contributions.\n" +
    "   - '10_SSPN': SSPN net deposits.\n" +
    "   - '11_EV_Charging': home EV charger purchase, installation, rental or hire-purchase, or a monthly EV charging subscription plan. Pay-per-use charging sessions at public chargers do NOT qualify: use 'NC_General_and_Non_Deductible' for those.\n" +
    "   - '12_Donations': donations or gifts to approved institutions with an official receipt.\n" +
    "   - 'NC_Employment_Reimbursements': expenses claimable from an employer (parking, mileage, work phone bills).\n" +
    "   - 'NC_Major_Assets_and_Warranties': home appliances, furniture, renovation, vehicle purchase, major repairs, servicing.\n" +
    "   - 'NC_General_and_Non_Deductible': everything else (groceries, dining, retail, road tax, utilities, pay-per-use EV charging sessions), or when category is not Receipts.\n" +
    "6. total_amount: The final total paid as a plain number (e.g., 45.90). If the document is a refund, credit note or reversal, return the amount as a NEGATIVE number (e.g., -12.90). If not a receipt or not readable, return 0.\n" +
    "7. currency: 3-letter ISO currency code of the total (e.g., 'MYR', 'SGD', 'USD'). If no currency is shown, return 'MYR'.\n" +
    "8. item_summary: A short description of what was bought (max 8 words, e.g., 'School stationery and exercise books'). If not a receipt, return ''.\n" +
    "9. claim_note: If only part of the amount is claimable, a short note for the taxpayer. For a mobile phone plan that includes calls or SMS, return 'Mobile plan: claim data portion only'. For a refund or credit note, return 'Refund / credit note'. Otherwise return ''.";

  const generationConfig = {
    temperature: 0.0,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    response_mime_type: 'application/json',
    response_schema: {
      type: 'OBJECT',
      properties: {
        category: { type: 'STRING', enum: TARGET_FOLDERS },
        vendor_name: { type: 'STRING' },
        short_title: { type: 'STRING' },
        transaction_date: { type: 'STRING' },
        receipt_subcategory: { type: 'STRING', enum: RECEIPT_SUBCATEGORIES },
        total_amount: { type: 'NUMBER' },
        currency: { type: 'STRING' },
        item_summary: { type: 'STRING' },
        claim_note: { type: 'STRING' }
      },
      required: ['category', 'vendor_name', 'short_title', 'transaction_date',
                 'receipt_subcategory', 'total_amount', 'currency', 'item_summary', 'claim_note']
    }
  };
  if (useThinking) generationConfig.thinkingConfig = THINKING_CONFIG;

  return {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: base64Data } },
          { text: promptText }
        ]
      }],
      generationConfig: generationConfig
    }),
    muteHttpExceptions: true
  };
}

function parseGeminiResponse_(body) {
  let json;
  try { json = JSON.parse(body); } catch (e) { return { ok: false, reason: 'unreadable response' }; }

  if (json.promptFeedback && json.promptFeedback.blockReason) {
    return { ok: false, permanent: true, reason: 'blocked: ' + json.promptFeedback.blockReason };
  }
  const candidate = json.candidates && json.candidates[0];
  if (!candidate) return { ok: false, reason: 'no candidates' };

  const finishReason = candidate.finishReason || '';
  if (/SAFETY|RECITATION|PROHIBITED|BLOCKLIST|SPII/.test(finishReason)) {
    return { ok: false, permanent: true, reason: 'finishReason ' + finishReason };
  }

  const parts = (candidate.content && candidate.content.parts) || [];
  const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');
  let data;
  try { data = JSON.parse(text); } catch (e) { return { ok: false, reason: 'bad JSON, finishReason ' + finishReason }; }

  if (!data || !TARGET_FOLDERS.includes(data.category)) return { ok: false, reason: 'invalid category' };
  return { ok: true, data: data };
}

// Refunds and credit notes must reduce totals, not add to them.
// Backup for when Gemini labels a document as a refund but still returns a positive amount.
function applyRefundRule_(result) {
  const text = (result.shortTitle + ' ' + result.itemSummary + ' ' + result.claimNote).toLowerCase();
  const isRefund = /credit note|refund|reversal/.test(text) || result.totalAmount < 0;
  if (!isRefund) return result;
  result.totalAmount = -Math.abs(Number(result.totalAmount) || 0);
  if (!/refund|credit note/i.test(result.claimNote)) {
    result.claimNote = result.claimNote ? 'Refund / credit note; ' + result.claimNote : 'Refund / credit note';
  }
  return result;
}

// Note for receipts where only part of the amount can be claimed.
// Uses Gemini's claim_note; falls back to a keyword check for mobile plans in Lifestyle.
function claimNoteFor_(result, subCategoryName) {
  const note = String(result.claimNote || '').trim();
  if (note) return note;
  if (subCategoryName !== '01_Lifestyle') return '';
  const text = (result.vendorName + ' ' + result.shortTitle + ' ' + result.itemSummary).toLowerCase();
  if (/(mobile|postpaid|prepaid|phone plan)/.test(text) && !/(fibre|fiber|broadband|home)/.test(text)) {
    return 'Mobile plan: claim data portion only';
  }
  return '';
}

// Models that returned 404 in the current run (reset at the start of each run)
let RETIRED_MODELS_ = {};

// Receipt_Email_Grab_2026-11-13.pdf  ->  13 Nov 2026 (the email's date), else null
function emailDateFromName_(name) {
  const m = /^Receipt_Email_[A-Za-z0-9]+_(\d{4})-(\d{2})-(\d{2})(?:_\d+)?\.[A-Za-z]+$/.exec(String(name || ''));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 4, 0, 0));   // noon in Malaysia
}

function msUntilPacificMidnight_() {
  const now = new Date();
  const h = Number(Utilities.formatDate(now, 'America/Los_Angeles', 'H'));
  const m = Number(Utilities.formatDate(now, 'America/Los_Angeles', 'm'));
  const s = Number(Utilities.formatDate(now, 'America/Los_Angeles', 's'));
  return (86400 - (h * 3600 + m * 60 + s)) * 1000 + 5 * 60 * 1000;
}


// =========================================================
// DATE CHECK
// =========================================================
function validateTransactionDate_(raw, scanDate) {
  const fallback = Utilities.formatDate(scanDate, TZ, 'yyyy-MM-dd');
  const scanDay = toUtcDay_(fallback);
  const oneDay = 24 * 60 * 60 * 1000;
  const oldest = scanDay - MAX_RECEIPT_AGE_YEARS * 365.25 * oneDay;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw || ''));
  if (!match) return { dateStr: fallback, note: 'Date unreadable, used scan/email date' };

  const y = Number(match[1]), mo = Number(match[2]), d = Number(match[3]);
  const isOk = t => t !== null && t <= scanDay + oneDay && t >= oldest;

  const asRead = realDate_(y, mo, d);
  if (isOk(asRead)) return { dateStr: raw, note: '' };

  const swapped = realDate_(y, d, mo);
  if (isOk(swapped)) {
    const swappedStr = y + '-' + pad2_(d) + '-' + pad2_(mo);
    return { dateStr: swappedStr, note: 'Day/month swapped from ' + raw + ', please check' };
  }

  return { dateStr: fallback, note: 'Printed date ' + raw + ' looked wrong, used scan/email date' };
}

function realDate_(y, mo, d) {
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  return (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) ? t : null;
}

function toUtcDay_(yyyyMmDd) {
  const p = yyyyMmDd.split('-').map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2]);
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }


// =========================================================
// FAILURE HANDLING
// =========================================================
function recordFailure_(props, file, failedFolder) {
  const key = 'FAILS_' + file.getId();
  const count = Number(props.getProperty(key) || 0) + 1;
  if (count >= MAX_FAILURES_PER_FILE && failedFolder) {
    props.deleteProperty(key);
    return moveToFailed_(file, failedFolder);
  }
  props.setProperty(key, String(count));
  return false;
}

function moveToFailed_(file, failedFolder) {
  if (!failedFolder) return false;
  try {
    file.moveTo(failedFolder);
    return true;
  } catch (e) {
    Logger.log('Could not move to Failed: ' + e);
    return false;
  }
}

function cleanupFailCounters_(props, sourceFolder) {
  const all = props.getProperties();
  const sourceId = sourceFolder.getId();
  Object.keys(all).forEach(key => {
    if (key.indexOf('FAILS_') !== 0) return;
    let keep = false;
    try {
      const f = DriveApp.getFileById(key.substring(6));
      if (!f.isTrashed()) {
        const parents = f.getParents();
        while (parents.hasNext()) {
          if (parents.next().getId() === sourceId) { keep = true; break; }
        }
      }
    } catch (e) {
      keep = false;
    }
    if (!keep) props.deleteProperty(key);
  });
}

function safeName_(file) {
  try { return file.getName(); } catch (e) { return '(unknown file)'; }
}


// =========================================================
// FOLDERS
// =========================================================
function escapeQuery_(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function findChildFolder_(parentFolder, folderName) {
  const it = parentFolder.searchFolders("title = '" + escapeQuery_(folderName) + "' and trashed = false");
  return it.hasNext() ? it.next() : null;
}

function resolveFolder_(props, folderName, createIfMissing) {
  const key = 'FOLDER_ID_' + folderName;
  const savedId = props.getProperty(key);

  if (savedId) {
    try {
      const saved = DriveApp.getFolderById(savedId);
      if (!saved.isTrashed()) return saved;
    } catch (e) {
      // Folder deleted or access lost; look it up again below
    }
    props.deleteProperty(key);
  }

  let folder = findChildFolder_(DriveApp.getRootFolder(), folderName);
  if (!folder) {
    const anywhere = DriveApp.searchFolders("title = '" + escapeQuery_(folderName) + "' and trashed = false");
    if (anywhere.hasNext()) folder = anywhere.next();
  }

  if (!folder && createIfMissing) {
    folder = DriveApp.getRootFolder().createFolder(folderName);
    Logger.log('Created folder in My Drive root: ' + folderName);
  }
  if (folder) props.setProperty(key, folder.getId());
  return folder;
}

function getOrCreateSubfolder_(parentFolder, subfolderName) {
  const existing = findChildFolder_(parentFolder, subfolderName);
  if (existing) return existing;
  Logger.log('Creating new subfolder: ' + subfolderName + ' inside ' + parentFolder.getName());
  return parentFolder.createFolder(subfolderName);
}


// =========================================================
// RECEIPT TAX TRACKER SHEET
// =========================================================
function safeCell_(value) {
  const s = String(value == null ? '' : value);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function getTrackerSheet_(props) {
  const key = 'TRACKER_SHEET_ID';
  let ss = null;

  const savedId = props.getProperty(key);
  if (savedId) {
    try { ss = SpreadsheetApp.openById(savedId); } catch (e) { ss = null; }
  }
  if (!ss) {
    const found = DriveApp.getFilesByName(TRACKER_SHEET_NAME);
    while (found.hasNext()) {
      const f = found.next();
      if (f.getMimeType() === MimeType.GOOGLE_SHEETS && !f.isTrashed()) {
        ss = SpreadsheetApp.openById(f.getId());
        break;
      }
    }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(TRACKER_SHEET_NAME);
    Logger.log('Created tracker sheet: ' + ss.getUrl());
  }
  props.setProperty(key, ss.getId());

  let sheet = ss.getSheetByName(TRACKER_TAB_NAME);
  if (!sheet) {
    const tabs = ss.getSheets();
    if (tabs.length === 1 && tabs[0].getLastRow() === 0) {
      sheet = tabs[0];
      sheet.setName(TRACKER_TAB_NAME);
    } else {
      sheet = ss.insertSheet(TRACKER_TAB_NAME);
    }
  }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(TRACKER_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, TRACKER_HEADERS.length).setFontWeight('bold');
    const rows = sheet.getMaxRows() - 1;
    const col = name => TRACKER_HEADERS.indexOf(name) + 1;
    sheet.getRange(2, col('Logged At'), rows, 1).setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange(2, col('Transaction Date'), rows, 1).setNumberFormat('yyyy-mm-dd');
    sheet.getRange(2, col('Amount'), rows, 1).setNumberFormat('#,##0.00');
  }
  return sheet;
}

// File IDs already logged. A row only counts if it also has a vendor, amount or link,
// so a half-cleared row (File ID left behind) can't block a receipt from being logged again.
function getLoggedFileIds_(sheet) {
  const ids = new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return ids;
  const data = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  const headers = data[0];
  const idCol = headers.indexOf('File ID');
  if (idCol === -1) return ids;
  const contentCols = ['Vendor', 'Amount', 'Receipt Link'].map(h => headers.indexOf(h)).filter(i => i !== -1);

  let ignored = 0;
  for (let r = 1; r < data.length; r++) {
    const id = data[r][idCol];
    if (!id) continue;
    const hasContent = contentCols.some(c => data[r][c] !== '' && data[r][c] !== null);
    if (hasContent) {
      ids.add(String(id));
    } else {
      ignored++;
    }
  }
  if (ignored > 0) {
    Logger.log('Tracker: ignored ' + ignored + ' blank row(s) that only had a File ID. ' +
               'Run cleanupBlankTrackerRows to remove them.');
  }
  return ids;
}

// Manual clean-up: deletes rows with no Vendor, Amount or Receipt Link
// (for example rows that were cleared by hand but still hold a File ID).
function cleanupBlankTrackerRows() {
  const sheet = getTrackerSheet_(PropertiesService.getScriptProperties());
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('Nothing to clean up.'); return; }
  const data = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  const headers = data[0];
  const contentCols = ['Vendor', 'Amount', 'Receipt Link'].map(h => headers.indexOf(h)).filter(i => i !== -1);
  if (contentCols.length === 0) { Logger.log('Headers not recognised. Nothing deleted.'); return; }

  const blankRows = [];
  for (let r = 1; r < data.length; r++) {
    const hasContent = contentCols.some(c => data[r][c] !== '' && data[r][c] !== null);
    if (!hasContent) blankRows.push(r + 1);   // sheet row number
  }
  // Delete from the bottom up so row numbers don't shift
  blankRows.reverse().forEach(rowNum => sheet.deleteRow(rowNum));
  Logger.log(blankRows.length ? 'Deleted blank row(s): ' + blankRows.reverse().join(', ') : 'No blank rows found.');
}



// =========================================================
// EMAIL RECEIPT IMPORT (v6)
// Finds receipt emails in Gmail and saves them into Brother:
//   - PDF / JPEG / PNG attachments are saved as they are
//   - emails with no such attachment are saved as a PDF snapshot of the email
// Every email MESSAGE handled gets a row in the "Email Import Log" tab of the
// tracker sheet, so a new receipt arriving in an old Gmail conversation is still
// picked up. Identical attachments (e.g. a receipt you forwarded) are saved once.
// Gmail labels are added so you can see what happened in Gmail.
// To retry an email: delete its row in the Email Import Log tab.
// =========================================================

const EMAIL_LOG_HEADERS = ['Logged At', 'Message ID', 'Thread ID', 'Email Date', 'From', 'Subject',
                           'Status', 'Files Saved', 'Content Hashes', 'Note'];

// Manual run: imports emails only (no classification). Handy for testing.
function importEmailReceipts() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('Another run is still active. Exiting this one.');
    return;
  }
  try {
    importEmailReceipts_(Date.now() + EMAIL_IMPORT_BUDGET_MS);
  } finally {
    lock.releaseLock();
  }
}

// Dry run: lists up to 50 emails that WOULD be handled. Saves nothing, labels nothing, costs nothing.
function testEmailSearch() {
  const props = PropertiesService.getScriptProperties();
  const state = loadEmailLog_(props, false);
  const migrated = props.getProperty('EMAIL_LOG_MIGRATED') === 'true';
  const oldLabels = [EMAIL_IMPORTED_LABEL, EMAIL_FAILED_LABEL, EMAIL_SKIPPED_LABEL];
  const startMs = new Date(EMAIL_START_DATE).getTime();
  const query = buildEmailQuery_(emailWindowStart_(props));
  Logger.log('Gmail search: ' + query);

  let shown = 0;
  for (let page = 0; page < EMAIL_MAX_PAGES_PER_RUN && shown < 50; page++) {
    const threads = GmailApp.search(query, page * EMAIL_PAGE_SIZE, EMAIL_PAGE_SIZE);
    threads.forEach(thread => {
      // Before the first real v6 run, emails handled by v5 (labelled) count as done
      const handledByV5 = !migrated && thread.getLabels().some(l => oldLabels.indexOf(l.getName()) !== -1);
      if (handledByV5) return;
      thread.getMessages().forEach(message => {
        if (shown >= 50 || state.ids.has(message.getId()) || message.getDate().getTime() < startMs) return;
        const decision = decideMessage_(message, thread);
        const usable = decision.skip ? [] : getUsableAttachments_(message);
        Logger.log(Utilities.formatDate(message.getDate(), TZ, 'yyyy-MM-dd') + ' | ' +
                   message.getFrom() + ' | ' + message.getSubject() + ' | ' +
                   (decision.skip ? 'skip: ' + decision.reason
                                  : (usable.length ? usable.length + ' attachment(s) to save' : 'no attachment: email -> PDF')));
        shown++;
      });
    });
    if (threads.length < EMAIL_PAGE_SIZE) break;
  }
  Logger.log('Listed ' + shown + ' new email(s) (max 50). Nothing was saved or labelled.');
}

function importEmailReceipts_(deadline) {
  if (!EMAIL_IMPORT_ENABLED) return;
  const props = PropertiesService.getScriptProperties();

  const brother = findChildFolder_(DriveApp.getRootFolder(), SOURCE_FOLDER_NAME);
  if (!brother) {
    Logger.log('Email import: Brother folder not found. Skipping.');
    return;
  }

  const state = loadEmailLog_(props, true);
  migrateV5Labels_(props, state);

  const labels = {
    Imported: getOrCreateLabel_(EMAIL_IMPORTED_LABEL),
    Failed: getOrCreateLabel_(EMAIL_FAILED_LABEL),
    Skipped: getOrCreateLabel_(EMAIL_SKIPPED_LABEL),
    Duplicate: getOrCreateLabel_(EMAIL_SKIPPED_LABEL)
  };

  // Daily cap (Malaysia day)
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  if (props.getProperty('EMAIL_CAP_DAY') !== today) {
    props.setProperty('EMAIL_CAP_DAY', today);
    props.setProperty('EMAIL_CAP_COUNT', '0');
  }
  let savedToday = Number(props.getProperty('EMAIL_CAP_COUNT') || 0);

  const startMs = new Date(EMAIL_START_DATE).getTime();
  const query = buildEmailQuery_(emailWindowStart_(props));
  const failures = [];
  let savedTotal = 0;
  let handled = 0;
  let reachedEnd = false;
  let stopReason = '';

  pages:
  for (let page = 0; page < EMAIL_MAX_PAGES_PER_RUN; page++) {
    const threads = GmailApp.search(query, page * EMAIL_PAGE_SIZE, EMAIL_PAGE_SIZE);
    for (let t = 0; t < threads.length; t++) {
      const thread = threads[t];
      const messages = thread.getMessages();
      for (let m = 0; m < messages.length; m++) {
        const message = messages[m];
        if (state.ids.has(message.getId())) continue;                 // already handled
        if (message.getDate().getTime() < startMs) continue;          // older message in an active conversation
        if (Date.now() > deadline) { stopReason = 'time budget used'; break pages; }
        if (savedToday >= EMAIL_MAX_FILES_PER_DAY) { stopReason = 'daily cap of ' + EMAIL_MAX_FILES_PER_DAY + ' files reached'; break pages; }

        const outcome = handleEmailMessage_(message, thread, brother, state);
        // Record first, then label: the log is what prevents repeats
        logEmailMessage_(state, message, thread, outcome);
        addLabelSafely_(thread, labels[outcome.status]);
        if (outcome.status === 'Imported' && outcome.failures.length) addLabelSafely_(thread, labels.Failed);

        savedTotal += outcome.saved;
        savedToday += outcome.saved;
        props.setProperty('EMAIL_CAP_COUNT', String(savedToday));
        outcome.failures.forEach(reason => failures.push(describeFailure_(message, thread, reason)));
        handled++;
      }
    }
    if (threads.length < EMAIL_PAGE_SIZE) { reachedEnd = true; break; }
  }

  if (reachedEnd && props.getProperty('EMAIL_BACKLOG_DONE') !== 'true') {
    props.setProperty('EMAIL_BACKLOG_DONE', 'true');
    Logger.log('Email import: backlog cleared. From now on only the last ' + EMAIL_RESCAN_DAYS + ' days are checked.');
  }
  Logger.log('Email import complete. Messages handled: ' + handled + ', files saved: ' + savedTotal +
             ', failed: ' + failures.length + (stopReason ? ' (stopped early: ' + stopReason + ')' : ''));
  if (failures.length > 0) sendImportFailureEmail_(failures);
}

// Search window: from EMAIL_START_DATE during the backlog, then only the last EMAIL_RESCAN_DAYS days
function emailWindowStart_(props) {
  const startSec = Math.floor(new Date(EMAIL_START_DATE).getTime() / 1000);
  if (props.getProperty('EMAIL_BACKLOG_DONE') !== 'true') return startSec;
  return Math.max(startSec, Math.floor(Date.now() / 1000) - EMAIL_RESCAN_DAYS * 86400);
}

function buildEmailQuery_(afterSeconds) {
  const excluded = EMAIL_EXCLUDE_SUBJECT_WORDS
    .map(w => ' -subject:' + (w.indexOf(' ') !== -1 ? '"' + w + '"' : w))
    .join('');
  const excludedSenders = EMAIL_EXCLUDE_SENDERS
    .map(s => ' -from:"' + s.replace(/"/g, '') + '"')
    .join('');
  // after:<seconds> is exact; after:YYYY/MM/DD would be read in US Pacific time
  return '(' + EMAIL_KEYWORDS.join(' OR ') + ') ' + EMAIL_EXTRA_FILTERS + excluded + excludedSenders +
         ' after:' + afterSeconds;
}

// Decides whether a message should be imported, before anything is saved
function decideMessage_(message, thread) {
  if (!isReceiptMessage_(message)) return { skip: true, reason: 'Not a receipt, or filtered out' };
  if (isForward_(message.getSubject()) && threadHasOriginalReceipt_(thread, message)) {
    return { skip: true, reason: 'Forward of a receipt already in this conversation' };
  }
  return { skip: false };
}

function isForward_(subject) {
  return /^\s*(fwd?|fw)\s*:/i.test(subject || '');
}

// True when the same conversation already holds the original (non-forwarded) receipt
function threadHasOriginalReceipt_(thread, forwardMessage) {
  return thread.getMessages().some(m =>
    m.getId() !== forwardMessage.getId() &&
    !isForward_(m.getSubject()) &&
    !isFromMe_(m.getFrom()) &&
    isReceiptMessage_(m));
}

function handleEmailMessage_(message, thread, brother, state) {
  const decision = decideMessage_(message, thread);
  if (decision.skip) {
    return { status: 'Skipped', saved: 0, hashes: [], failures: [], note: decision.reason };
  }
  const r = importMessage_(message, brother, state);
  let status;
  if (r.saved > 0) status = 'Imported';
  else if (r.failures.length > 0) status = 'Failed';
  else if (r.duplicates > 0) status = 'Duplicate';
  else status = 'Skipped';
  const notes = r.notes.slice();
  if (r.duplicates > 0) notes.push(r.duplicates + ' identical file(s) already saved earlier');
  r.failures.forEach(f => notes.push('FAILED: ' + f));
  return { status: status, saved: r.saved, hashes: r.hashes, failures: r.failures, note: notes.join('; ') };
}

// Only messages that mention a keyword. Skips our own notices, excluded subjects and senders,
// and emails you sent yourself (unless you forwarded them, e.g. "Fwd: Receipt").
function isReceiptMessage_(message) {
  const subject = message.getSubject() || '';
  if (/^Drive Classifier/i.test(subject)) return false;

  const lowerSubject = subject.toLowerCase();
  if (EMAIL_EXCLUDE_SUBJECT_WORDS.some(w => lowerSubject.indexOf(w.toLowerCase()) !== -1)) return false;

  const lowerFrom = String(message.getFrom() || '').toLowerCase();
  if (EMAIL_EXCLUDE_SENDERS.some(s => lowerFrom.indexOf(s.toLowerCase()) !== -1)) return false;

  if (!isForward_(subject) && isFromMe_(message.getFrom())) return false;

  const re = new RegExp('\\b(' + EMAIL_KEYWORDS.join('|') + ')', 'i');
  const names = message.getAttachments({ includeInlineImages: false }).map(a => a.getName()).join(' ');
  return re.test(subject + ' ' + names + ' ' + (message.getPlainBody() || ''));
}

// PDF / JPEG / PNG attachments, minus tiny images such as logos
function getUsableAttachments_(message) {
  const usable = [];
  message.getAttachments({ includeInlineImages: false }).forEach(att => {
    const type = normaliseMime_(att.getContentType(), att.getName());
    if (!type) return;
    const size = att.getSize();
    if (type !== MimeType.PDF && size < EMAIL_MIN_IMAGE_BYTES) return;
    usable.push({ att: att, type: type, size: size });
  });
  return usable;
}

function importMessage_(message, brother, state) {
  const out = { saved: 0, failures: [], duplicates: 0, hashes: [], notes: [] };
  const base = 'Receipt_Email_' + senderTag_(message.getFrom()) + '_' +
               Utilities.formatDate(message.getDate(), TZ, 'yyyy-MM-dd');
  const usable = getUsableAttachments_(message);

  // Case 1: has attachments -> save the attachments only
  if (usable.length > 0) {
    usable.forEach((item, i) => {
      const label = item.att.getName() || ('attachment ' + (i + 1));
      try {
        if (item.size > MAX_FILE_BYTES) {
          out.failures.push('Attachment "' + label + '" is larger than ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MB');
          return;
        }
        const blob = item.att.copyBlob();
        const hash = contentHash_(blob.getBytes());
        if (state.hashes.has(hash)) {
          out.duplicates++;
          Logger.log('Email import: skipped identical copy of ' + label);
          return;
        }
        // Many bank/telco PDFs are print-restricted but still readable, so they go through.
        // If one really can't be read, the classifier's 3-strike rule moves it to Failed.
        if (item.type === MimeType.PDF && isEncryptedPdf_(blob)) {
          out.notes.push('"' + label + '" may be password-protected');
        }
        blob.setContentType(item.type);   // some senders label PDFs as generic files
        blob.setName(base + (usable.length > 1 ? '_' + (i + 1) : '') + extensionFor_(item.type));
        brother.createFile(blob);
        out.saved++;
        out.hashes.push(hash);
        state.hashes.add(hash);
        Logger.log('Email import: saved attachment ' + blob.getName());
      } catch (e) {
        out.failures.push('Could not save attachment "' + label + '": ' + e);
      }
    });
    return out;
  }

  // Case 2: no attachment -> save a PDF snapshot of the email itself
  try {
    const plain = (message.getPlainBody() || '').replace(/\s+/g, ' ').trim();
    if (plain.length < EMAIL_MIN_BODY_CHARS) {
      out.failures.push('No PDF or image attachment, and the email has almost no text (it may be a single image)');
      return out;
    }
    const pdf = emailToPdf_(message);
    const bytes = pdf.getBytes();
    if (bytes.length > MAX_FILE_BYTES) {
      out.failures.push('The email converted to a PDF larger than ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MB');
      return out;
    }
    pdf.setName(base + '.pdf');
    brother.createFile(pdf);
    out.saved++;
    out.hashes.push(contentHash_(bytes));
    Logger.log('Email import: saved email snapshot ' + pdf.getName());
  } catch (e) {
    out.failures.push('Could not convert the email to a PDF: ' + e);
  }
  return out;
}

// Short fingerprint of a file's content (first 32 hex characters of SHA-256)
function contentHash_(bytes) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  return Array.prototype.slice.call(digest)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('').substring(0, 32);
}

// ---- Email Import Log tab ----

// Reads the log into fast lookups. create=false never changes the sheet (used by the dry run).
function loadEmailLog_(props, create) {
  const ss = getTrackerSheet_(props).getParent();
  let sheet = ss.getSheetByName(EMAIL_LOG_TAB_NAME);
  if (!sheet && create) {
    sheet = ss.insertSheet(EMAIL_LOG_TAB_NAME);
    sheet.appendRow(EMAIL_LOG_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, EMAIL_LOG_HEADERS.length).setFontWeight('bold');
  }
  const ids = new Set();
  const hashes = new Set();
  if (sheet && sheet.getLastRow() >= 2) {
    const idCol = EMAIL_LOG_HEADERS.indexOf('Message ID');
    const hashCol = EMAIL_LOG_HEADERS.indexOf('Content Hashes');
    sheet.getRange(2, 1, sheet.getLastRow() - 1, EMAIL_LOG_HEADERS.length).getValues().forEach(row => {
      if (row[idCol]) ids.add(String(row[idCol]));
      String(row[hashCol] || '').split(',').forEach(h => { if (h.trim()) hashes.add(h.trim()); });
    });
  }
  return { sheet: sheet, ids: ids, hashes: hashes };
}

function logEmailMessage_(state, message, thread, outcome) {
  state.sheet.appendRow([
    new Date(),
    safeCell_(message.getId()),
    safeCell_(thread.getId()),
    message.getDate(),
    safeCell_(message.getFrom()),
    safeCell_(message.getSubject()),
    outcome.status,
    outcome.saved,
    outcome.hashes.join(','),
    safeCell_(outcome.note)
  ]);
  state.ids.add(message.getId());
  outcome.hashes.forEach(h => state.hashes.add(h));
}

// One-off: emails already handled by v5 (found by its Gmail labels) are recorded as done,
// so the switch to the log doesn't import them a second time.
function migrateV5Labels_(props, state) {
  if (props.getProperty('EMAIL_LOG_MIGRATED') === 'true') return;
  const rows = [];
  [EMAIL_IMPORTED_LABEL, EMAIL_FAILED_LABEL, EMAIL_SKIPPED_LABEL].forEach(name => {
    const label = GmailApp.getUserLabelByName(name);
    if (!label) return;
    for (let start = 0; ; start += 100) {
      const threads = label.getThreads(start, 100);
      threads.forEach(thread => thread.getMessages().forEach(message => {
        const id = message.getId();
        if (state.ids.has(id)) return;
        state.ids.add(id);
        rows.push([new Date(), safeCell_(id), safeCell_(thread.getId()), message.getDate(),
                   safeCell_(message.getFrom()), safeCell_(message.getSubject()),
                   'Migrated', 0, '', 'Handled by v5 (Gmail label ' + name + ')']);
      }));
      if (threads.length < 100) break;
    }
  });
  if (rows.length) {
    state.sheet.getRange(state.sheet.getLastRow() + 1, 1, rows.length, EMAIL_LOG_HEADERS.length).setValues(rows);
  }
  props.setProperty('EMAIL_LOG_MIGRATED', 'true');
  Logger.log('Email import: recorded ' + rows.length + ' message(s) already handled by v5.');
}

function addLabelSafely_(thread, label) {
  try {
    if (label) thread.addLabel(label);
  } catch (e) {
    Logger.log('Could not add Gmail label (the log still records the email): ' + e);
  }
}

// Builds "From / Subject / Date" header + the email body, then converts to PDF (no AI involved)
function emailToPdf_(message) {
  const raw = message.getBody() || '';
  let content;
  let styles = '';

  if (/<[a-z][\s\S]*>/i.test(raw)) {
    styles = (raw.match(/<style[\s\S]*?<\/style>/gi) || []).join('\n');
    const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(raw);
    content = (bodyMatch ? bodyMatch[1] : raw)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      // Images and remote stylesheets are removed: they usually fail to load and can stall the conversion.
      .replace(/<img\b[^>]*>/gi, '')
      .replace(/<link\b[^>]*>/gi, '');
  } else {
    content = '<pre style="white-space:pre-wrap;font-family:Arial,sans-serif;font-size:12px">' +
              escapeHtml_(message.getPlainBody() || '') + '</pre>';
  }

  const header =
    '<div style="font-family:Arial,sans-serif;font-size:12px;border-bottom:1px solid #999;' +
    'padding-bottom:8px;margin-bottom:12px">' +
    '<b>From:</b> ' + escapeHtml_(message.getFrom()) + '<br>' +
    '<b>Subject:</b> ' + escapeHtml_(message.getSubject()) + '<br>' +
    '<b>Date:</b> ' + Utilities.formatDate(message.getDate(), TZ, 'd MMM yyyy, HH:mm') + ' (MYT)' +
    '</div>';

  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' + styles + '</head><body>' +
               header + content + '</body></html>';
  return Utilities.newBlob(html, MimeType.HTML, 'email.html').getAs(MimeType.PDF);
}

// "Grab" <no-reply@grab.com>  ->  Grab
function senderTag_(from) {
  const text = String(from || '');
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(text);
  let name = m ? m[1].trim() : '';
  const address = m ? m[2] : text;

  if (!name || /^(no.?reply|noreply|notifications?|info|support|billing)$/i.test(name)) {
    const skip = ['com', 'my', 'net', 'org', 'co', 'gov', 'edu', 'email', 'mail', 'e', 'info', 'notification', 'notifications', 'mailer'];
    const parts = (address.split('@')[1] || '').toLowerCase().split('.');
    const pick = parts.find(p => p && skip.indexOf(p) === -1) || '';
    name = pick.charAt(0).toUpperCase() + pick.slice(1);
  }
  return name.replace(/[^A-Za-z0-9]+/g, '').substring(0, 25) || 'Unknown';
}

function normaliseMime_(contentType, fileName) {
  const t = String(contentType || '').toLowerCase().split(';')[0].trim();
  const n = String(fileName || '').toLowerCase();
  if (t === 'application/pdf' || n.endsWith('.pdf')) return MimeType.PDF;
  if (t === 'image/jpeg' || t === 'image/jpg' || t === 'image/pjpeg' || /\.jpe?g$/.test(n)) return MimeType.JPEG;
  if (t === 'image/png' || n.endsWith('.png')) return MimeType.PNG;
  return null;
}

function extensionFor_(mimeType) {
  if (mimeType === MimeType.PDF) return '.pdf';
  if (mimeType === MimeType.JPEG) return '.jpg';
  if (mimeType === MimeType.PNG) return '.png';
  return '';
}

// Password-protected PDFs contain an /Encrypt entry
function isEncryptedPdf_(blob) {
  try {
    return blob.getDataAsString('ISO-8859-1').indexOf('/Encrypt') !== -1;
  } catch (e) {
    return false;
  }
}

function escapeHtml_(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// True when the email was sent from your own Google account
let MY_EMAIL_CACHE_ = null;
function isFromMe_(from) {
  if (MY_EMAIL_CACHE_ === null) MY_EMAIL_CACHE_ = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!MY_EMAIL_CACHE_) return false;
  const m = /<([^>]+)>/.exec(String(from || ''));
  const address = (m ? m[1] : String(from || '')).trim().toLowerCase();
  return address === MY_EMAIL_CACHE_;
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function describeFailure_(message, thread, reason) {
  return {
    subject: message ? message.getSubject() : '(unknown)',
    from: message ? message.getFrom() : '(unknown)',
    date: message ? Utilities.formatDate(message.getDate(), TZ, 'd MMM yyyy, HH:mm') : '',
    reason: reason,
    link: 'https://mail.google.com/mail/u/0/#all/' + thread.getId()
  };
}

function sendImportFailureEmail_(failures) {
  const email = Session.getEffectiveUser().getEmail();
  if (!email) return;

  let body = 'Hello,\n\n' + failures.length + ' email receipt(s) could not be imported automatically:\n\n';
  failures.forEach((f, i) => {
    body += (i + 1) + '. Subject: ' + f.subject + '\n' +
            '   From: ' + f.from + '\n' +
            '   Date: ' + f.date + '\n' +
            '   Problem: ' + f.reason + '\n' +
            '   Open email: ' + f.link + '\n\n';
  });
  body += 'What you can do:\n' +
          '- Save the receipt into the Brother folder yourself, or\n' +
          '- Ignore it if it isn\'t a receipt.\n\n' +
          'To make the script try again, delete that email\'s row in the "' + EMAIL_LOG_TAB_NAME + '" tab ' +
          'of your ' + TRACKER_SHEET_NAME + ' sheet.\n';

  MailApp.sendEmail(email, 'Drive Classifier Notice: Email receipts need your attention', body);
}


// =========================================================
// HEALTH CHECKS (v6)
// - Setup problems pause the run and email you (at most once a day)
// - A weekly summary email doubles as a heartbeat: if it stops arriving,
//   the trigger has probably stopped
// =========================================================

// Records how the last run ended. problem = '' means healthy.
function recordRunStatus_(props, problem) {
  if (problem) {
    props.setProperty('LAST_RUN_PROBLEM', problem);
  } else {
    props.setProperty('LAST_RUN_OK', String(Date.now()));
    props.deleteProperty('LAST_RUN_PROBLEM');
  }
}

// Emails you about a setup problem, at most once per day
function sendSetupAlert_(props, reason) {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  if (props.getProperty('SETUP_ALERT_DAY') === today) {
    Logger.log('Setup alert already sent today. Not sending again.');
    return;
  }
  const email = Session.getEffectiveUser().getEmail();
  if (!email) return;

  const body =
    'Hello,\n\n' +
    'The Drive Classifier found a setup problem and paused processing:\n\n' +
    '   ' + reason + '\n\n' +
    'Your files are safe. They stay in the ' + SOURCE_FOLDER_NAME + ' folder and are NOT counted as failures.\n' +
    'The script tries again on every scheduled run and carries on by itself once the problem is fixed.\n\n' +
    'Things to check:\n' +
    '- Google AI Studio: is the API key active, and are the model names in GEMINI_MODELS still listed?\n' +
    '- Google Cloud: is billing on and the Generative Language API enabled?\n' +
    '- Apps Script > Project Settings > Script Properties: is GEMINI_API_KEY set?\n\n' +
    'You will get at most one of these emails per day.\n';

  MailApp.sendEmail(email, 'Drive Classifier Alert: setup problem, processing paused', body);
  props.setProperty('SETUP_ALERT_DAY', today);
  Logger.log('Setup alert emailed.');
}

// Called at the end of every trigger run; sends the summary once every SUMMARY_INTERVAL_DAYS
function maybeSendWeeklySummary_() {
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty('LAST_SUMMARY_SENT') || 0);
  const interval = SUMMARY_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  if (Date.now() - last < interval) return;
  sendWeeklySummary_(props);
  props.setProperty('LAST_SUMMARY_SENT', String(Date.now()));
}

// Manual run: sends the summary right now (does not change the weekly schedule)
function sendWeeklySummaryNow() {
  sendWeeklySummary_(PropertiesService.getScriptProperties());
}

function sendWeeklySummary_(props) {
  const email = Session.getEffectiveUser().getEmail();
  if (!email) return;
  const now = Date.now();
  const since = now - SUMMARY_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

  // ---- Receipts logged in the period ----
  let logged = 0, claimable = 0, withNotes = 0, claimableMyr = 0, claimableOther = 0;
  const byRelief = {};
  try {
    const sheet = getTrackerSheet_(props);
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const data = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
      const h = data[0];
      const c = name => h.indexOf(name);
      for (let r = 1; r < data.length; r++) {
        const row = data[r];
        const loggedAt = row[c('Logged At')];
        if (!loggedAt || typeof loggedAt.getTime !== 'function' || loggedAt.getTime() < since) continue;
        if (row[c('Vendor')] === '' && row[c('Amount')] === '') continue;   // blank row
        logged++;
        const relief = String(row[c('Relief Subcategory')] || '');
        byRelief[relief] = (byRelief[relief] || 0) + 1;
        if (relief && relief.indexOf('NC_') !== 0) {
          claimable++;
          if (String(row[c('Currency')] || 'MYR') === 'MYR') claimableMyr += Number(row[c('Amount')]) || 0;
          else claimableOther++;
        }
        if (row[c('Notes')]) withNotes++;
      }
    }
  } catch (e) {
    Logger.log('Summary: could not read the tracker sheet: ' + e);
  }

  // ---- Files waiting ----
  const brotherCount = countFilesIn_(findChildFolder_(DriveApp.getRootFolder(), SOURCE_FOLDER_NAME));
  const failedCount = countFilesIn_(resolveFolder_(props, FAILED_FOLDER_NAME, false));

  // ---- Email import activity in the period ----
  const emailStats = { Imported: 0, Failed: 0, Duplicate: 0, Skipped: 0 };
  try {
    const logSheet = getTrackerSheet_(props).getParent().getSheetByName(EMAIL_LOG_TAB_NAME);
    if (logSheet && logSheet.getLastRow() >= 2) {
      const statusCol = EMAIL_LOG_HEADERS.indexOf('Status');
      logSheet.getRange(2, 1, logSheet.getLastRow() - 1, EMAIL_LOG_HEADERS.length).getValues().forEach(row => {
        const at = row[0];
        if (!at || typeof at.getTime !== 'function' || at.getTime() < since) return;
        if (row[statusCol] in emailStats) emailStats[row[statusCol]]++;
      });
    }
  } catch (e) {
    Logger.log('Summary: could not read the email log: ' + e);
  }

  // ---- Health ----
  const lastOk = Number(props.getProperty('LAST_RUN_OK') || 0);
  const lastClassified = Number(props.getProperty('LAST_CLASSIFY_SUCCESS') || 0);
  const problem = props.getProperty('LAST_RUN_PROBLEM');
  const staleMs = STALE_RUN_HOURS * 60 * 60 * 1000;
  const hoursAgo = t => Math.round((now - t) / 3600000);
  let health;
  if (problem) {
    health = 'PROBLEM: ' + problem;
  } else if (!lastOk) {
    health = 'No successful run recorded yet.';
  } else if (now - lastOk > staleMs) {
    health = 'WARNING: last successful run was ' + hoursAgo(lastOk) + ' hours ago. Check Triggers in Apps Script.';
  } else if (brotherCount > 0 && (!lastClassified || now - lastClassified > staleMs)) {
    // Runs are happening but nothing gets classified: likely a Gemini outage, quota or billing issue
    health = 'WARNING: ' + brotherCount + ' file(s) waiting in ' + SOURCE_FOLDER_NAME + ', but nothing was classified ' +
             (lastClassified ? 'in the last ' + hoursAgo(lastClassified) + ' hours' : 'yet') +
             '. Check Gemini (quota, billing or an outage) and the execution log.';
  } else {
    health = 'OK';
  }
  const fmt = t => t ? Utilities.formatDate(new Date(t), TZ, 'd MMM yyyy, HH:mm') + ' (MYT)' : 'never';
  const lastOkText = fmt(lastOk);

  // ---- Email ----
  let body = 'Hello,\n\nDrive Classifier summary for the last ' + SUMMARY_INTERVAL_DAYS + ' days:\n\n' +
    'HEALTH\n' +
    '- Status: ' + health + '\n' +
    '- Last successful run: ' + lastOkText + '\n' +
    '- Last file classified: ' + fmt(lastClassified) + '\n\n' +
    'RECEIPTS LOGGED\n' +
    '- Total: ' + logged + ' (claimable: ' + claimable + ', non-claimable: ' + (logged - claimable) + ')\n' +
    '- Claimable total (MYR): ' + claimableMyr.toFixed(2) +
    (claimableOther ? ' (' + claimableOther + ' non-MYR receipt(s) not included)' : '') + '\n' +
    '- Rows with notes to check: ' + withNotes + '\n';
  Object.keys(byRelief).sort().forEach(k => { body += '   ' + (k || '(none)') + ': ' + byRelief[k] + '\n'; });
  body += '\nEMAIL IMPORT\n' +
    '- Imported: ' + emailStats.Imported + ', failed: ' + emailStats.Failed +
    ', duplicates skipped: ' + emailStats.Duplicate + ', not receipts: ' + emailStats.Skipped + '\n';
  body += '\nWAITING FOR YOU\n' +
    '- Files still in ' + SOURCE_FOLDER_NAME + ': ' + brotherCount + '\n' +
    '- Files in ' + FAILED_FOLDER_NAME + ': ' + failedCount + '\n\n' +
    'You get this email every ' + SUMMARY_INTERVAL_DAYS + ' days. If it stops arriving, the trigger has probably ' +
    'stopped: open Apps Script > Triggers to check.\n';

  const subject = 'Drive Classifier Weekly Summary' + (health === 'OK' ? '' : ': needs attention');
  MailApp.sendEmail(email, subject, body);
  Logger.log('Weekly summary emailed.');
}

function countFilesIn_(folder) {
  if (!folder) return 0;
  let n = 0;
  const it = folder.getFiles();
  while (it.hasNext() && n < 1000) { it.next(); n++; }
  return n;
}
