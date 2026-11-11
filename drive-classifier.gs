// =========================================================
// DRIVE CLASSIFIER + RECEIPT TAX TRACKER (v4)
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
    runClassifier_();
  } finally {
    lock.releaseLock();
  }
}


// =========================================================
// MAIN LOGIC
// =========================================================
function runClassifier_() {
  const startTime = Date.now();
  const deadline = startTime + MAX_EXECUTION_TIME_MS;
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  Logger.log('--- EXECUTION START ---');

  if (!apiKey || apiKey.trim() === '') {
    Logger.log('CRITICAL ERROR: GEMINI_API_KEY is missing in Script Properties. Aborting run.');
    return;
  }

  // 1. Find 'Brother' at the Root level
  const rootFolder = DriveApp.getRootFolder();
  const sourceFolder = findChildFolder_(rootFolder, SOURCE_FOLDER_NAME);
  if (!sourceFolder) {
    Logger.log('Source folder "' + SOURCE_FOLDER_NAME + '" not found in Root directory.');
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
  const files = sourceFolder.getFiles();
  let brotherFileCount = 0;
  let apiCallCount = 0;
  let processedCount = 0;
  let unknownFilesCount = 0;
  let failedFilesCount = 0;
  let receiptsLogged = 0;
  let dailyQuotaHit = false;

  while (files.hasNext()) {
    if (Date.now() > deadline) {
      Logger.log('Approaching script timeout. Remaining files will process on next run.');
      break;
    }

    const file = files.next();
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
        if (recordFailure_(props, file, failedFolder)) {
          failedFilesCount++;
          Logger.log('File failed ' + MAX_FAILURES_PER_FILE + ' times. Moved to Failed.');
        } else {
          Logger.log('API failed for this file (left in Brother, will retry next run): ' + file.getName());
        }
        continue;
      }

      // ---- Success: work out date, year and destination BEFORE touching the file ----
      const fileId = file.getId();
      props.deleteProperty('FAILS_' + fileId);

      const createdDate = file.getDateCreated();
      const scanTimeStr = Utilities.formatDate(createdDate, TZ, 'HHmm');
      const dateCheck = validateTransactionDate_(result.transactionDate, createdDate);
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
          safeCell_(dateCheck.note),
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

  Logger.log('Execution complete. Inspected: ' + brotherFileCount +
             ', Processed: ' + processedCount +
             ', Receipts logged: ' + receiptsLogged +
             ', Failed: ' + failedFilesCount);

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

  for (let m = 0; m < GEMINI_MODELS.length; m++) {
    const modelName = GEMINI_MODELS[m];
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
          return {
            apiError: false,
            category: d.category,
            vendorName: d.vendor_name || 'Unknown',
            shortTitle: d.short_title || 'Document',
            transactionDate: d.transaction_date || 'UNKNOWN',
            receiptSubcategory: d.receipt_subcategory || DEFAULT_SUBCATEGORY,
            totalAmount: typeof d.total_amount === 'number' ? d.total_amount : 0,
            currency: (d.currency || 'MYR').toUpperCase().substring(0, 3),
            itemSummary: d.item_summary || ''
          };
        }
        if (parsed.permanent) return { apiError: true, permanent: true, reason: parsed.reason };
        Logger.log('Unusable answer from ' + modelName + ' (' + parsed.reason + '), attempt ' + attempt + '.');
        continue;
      }

      if (status === 404) {
        Logger.log('Model ' + modelName + ' returned 404. Switching to next fallback model...');
        break;
      }

      if (status === 400 && useThinking && /thinking/i.test(body)) {
        Logger.log('Model rejected thinkingConfig. Turning it off for future runs and retrying.');
        props.setProperty('THINKING_DISABLED', 'true');
        useThinking = false;
        attempt--;
        continue;
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
      return { apiError: true };
    }
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
    "   - '01_Lifestyle': books, magazines, newspapers, PCs, smartphones, tablets, home internet subscriptions.\n" +
    "   - '02_Sports': sports equipment, gym memberships, sports facility rental, sports competition fees, sports training.\n" +
    "   - '03_Medical_Family': medical treatment, dental, vaccination, full medical exam, health screening or mental health for self, spouse or child.\n" +
    "   - '04_Medical_Parents': medical, dental or care expenses for parents.\n" +
    "   - '05_Childcare': registered kindergarten or childcare centre fees.\n" +
    "   - '06_Education_Self': self-education fees (degree, masters, professional or skills courses).\n" +
    "   - '07_Life_Insurance_EPF': life insurance or takaful premiums, EPF voluntary contributions.\n" +
    "   - '08_Edu_Medical_Insurance': education or medical insurance premiums.\n" +
    "   - '09_PRS': Private Retirement Scheme contributions.\n" +
    "   - '10_SSPN': SSPN net deposits.\n" +
    "   - '11_EV_Charging': EV charging installation, rental, purchase or subscription.\n" +
    "   - '12_Donations': donations or gifts to approved institutions with an official receipt.\n" +
    "   - 'NC_Employment_Reimbursements': expenses claimable from an employer (parking, mileage, work phone bills).\n" +
    "   - 'NC_Major_Assets_and_Warranties': home appliances, furniture, renovation, vehicle purchase, major repairs, servicing.\n" +
    "   - 'NC_General_and_Non_Deductible': everything else (groceries, dining, retail, road tax, utilities), or when category is not Receipts.\n" +
    "6. total_amount: The final total paid as a plain number (e.g., 45.90). If not a receipt or not readable, return 0.\n" +
    "7. currency: 3-letter ISO currency code of the total (e.g., 'MYR', 'SGD', 'USD'). If no currency is shown, return 'MYR'.\n" +
    "8. item_summary: A short description of what was bought (max 8 words, e.g., 'School stationery and exercise books'). If not a receipt, return ''.";

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
        item_summary: { type: 'STRING' }
      },
      required: ['category', 'vendor_name', 'short_title', 'transaction_date',
                 'receipt_subcategory', 'total_amount', 'currency', 'item_summary']
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
  if (!match) return { dateStr: fallback, note: 'Date unreadable, used scan date' };

  const y = Number(match[1]), mo = Number(match[2]), d = Number(match[3]);
  const isOk = t => t !== null && t <= scanDay + oneDay && t >= oldest;

  const asRead = realDate_(y, mo, d);
  if (isOk(asRead)) return { dateStr: raw, note: '' };

  const swapped = realDate_(y, d, mo);
  if (isOk(swapped)) {
    const swappedStr = y + '-' + pad2_(d) + '-' + pad2_(mo);
    return { dateStr: swappedStr, note: 'Day/month swapped from ' + raw + ', please check' };
  }

  return { dateStr: fallback, note: 'Printed date ' + raw + ' looked wrong, used scan date' };
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

function getLoggedFileIds_(sheet) {
  const ids = new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return ids;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col = headers.indexOf('File ID') + 1;
  if (col === 0) return ids;
  sheet.getRange(2, col, lastRow - 1, 1).getValues().forEach(row => {
    if (row[0]) ids.add(String(row[0]));
  });
  return ids;
}


// =========================================================
// OPTIONAL: dry test for the tracker sheet (no Gemini, no files moved)
// =========================================================
function testTrackerSheet() {
  const props = PropertiesService.getScriptProperties();
  const sheet = getTrackerSheet_(props);
  sheet.appendRow([
    new Date(), 'YA 2026', Utilities.parseDate('2026-11-01', TZ, 'yyyy-MM-dd'),
    'TEST Vendor', safeCell_('=SUM(1,1)'), 'MYR', 12.5, '05_Childcare',
    'Test row, delete me', 'TEST-file.pdf', 'https://drive.google.com', 'TEST-' + Date.now()
  ]);
  Logger.log('Tracker sheet: ' + sheet.getParent().getUrl());
}
