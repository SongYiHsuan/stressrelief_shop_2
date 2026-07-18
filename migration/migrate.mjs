import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import XLSX from 'xlsx';
import {
  cert,
  getApps,
  initializeApp
} from 'firebase-admin/app';
import {
  FieldValue,
  Timestamp,
  getFirestore
} from 'firebase-admin/firestore';

const PROJECT_ID = 'stressrelief2-f3345';
const execute = process.argv.includes('--execute');
const dryRun = process.argv.includes('--dry-run');

if (!execute && !dryRun) {
  throw new Error('請使用 npm run dry-run 或 npm run migrate');
}

const root = process.cwd();
const xlsxPath = path.join(root, '會員系統資料庫.xlsx');
const keyPath = path.join(root, 'serviceAccountKey.json');

if (!fs.existsSync(xlsxPath)) {
  throw new Error('找不到 會員系統資料庫.xlsx');
}

if (!fs.existsSync(keyPath)) {
  throw new Error('找不到 serviceAccountKey.json');
}

const serviceAccount = JSON.parse(
  fs.readFileSync(keyPath, 'utf8')
);

if (serviceAccount.project_id !== PROJECT_ID) {
  throw new Error(
    `服務帳戶屬於 ${serviceAccount.project_id}，不是 ${PROJECT_ID}，已停止`
  );
}

if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount),
    projectId: PROJECT_ID
  });
}

const db = getFirestore();

const collectionConfig = {
  members: {
    primary: 'lineUserId'
  },
  walletLogs: {
    primary: 'logId'
  },
  staffLogs: {
    primary: 'id'
  },
  broadcastTargets: {
    primary: 'id'
  },
  broadcastLogs: {
    primary: 'broadcastId'
  },
  memberCoupons: {
    primary: 'id'
  },
  coupons: {
    primary: 'id'
  },
  activities: {
    primary: 'id'
  },
  pointLogs: {
    primary: 'logId'
  },
  otps: {
    primary: 'otpId'
  }
};

const numericFields = new Set([
  'amount',
  'beforeStoredValue',
  'afterStoredValue',
  'storedValue',
  'totalSpend',
  'points',
  'beforePoints',
  'afterPoints',
  'targetCount',
  'sentCount',
  'failedCount',
  'couponAmount',
  'sort'
]);

const booleanFields = new Set([
  'phoneVerified',
  'used'
]);

const dateFields = new Set([
  'createdAt',
  'updatedAt',
  'lastVisitAt',
  'issuedAt',
  'usedAt',
  'expiredAt',
  'claimedAt',
  'startAt',
  'endAt',
  'expiresAt'
]);

function excelSerialToDate(value) {
  const serial = Number(value);

  if (!Number.isFinite(serial)) {
    return null;
  }

  const utcDays = Math.floor(serial - 25569);
  const utcValue = utcDays * 86400;
  const fractionalDay = serial - Math.floor(serial);
  const totalSeconds = Math.round(86400 * fractionalDay);

  return new Date((utcValue + totalSeconds) * 1000);
}

function parseDate(value) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ''
  ) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (
    typeof value === 'number' ||
    /^\d{5}(?:\.\d+)?$/.test(String(value).trim())
  ) {
    return excelSerialToDate(value);
  }

  const raw = String(value).trim();

  const normalized = raw
    .replace(
      /^(\d{4})\/(\d{1,2})\/(\d{1,2})/,
      '$1-$2-$3'
    )
    .replace(' ', 'T');

  const parsed = new Date(normalized);

  return Number.isNaN(parsed.getTime())
    ? null
    : parsed;
}

function cleanValue(field, value) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ''
  ) {
    return null;
  }

  if (dateFields.has(field)) {
    const date = parseDate(value);
    return date ? Timestamp.fromDate(date) : null;
  }

  if (numericFields.has(field)) {
    const numberValue = Number(
      String(value).replace(/,/g, '')
    );

    return Number.isFinite(numberValue)
      ? numberValue
      : 0;
  }

  if (booleanFields.has(field)) {
    if (value === true || value === false) {
      return value;
    }

    return ['true', '1', 'yes', '是'].includes(
      String(value).trim().toLowerCase()
    );
  }

  return typeof value === 'string'
    ? value.trim()
    : value;
}

function cleanRow(row) {
  const output = {};

  for (const [field, value] of Object.entries(row)) {
    const cleanField = String(field || '').trim();

    if (!cleanField) {
      continue;
    }

    const cleaned = cleanValue(cleanField, value);

    if (cleaned !== null) {
      output[cleanField] = cleaned;
    }
  }

  return output;
}

function stableId(collectionName, row) {
  const source = JSON.stringify({
    collectionName,
    row
  });

  return (
    'MIG_' +
    crypto
      .createHash('sha256')
      .update(source)
      .digest('hex')
      .slice(0, 28)
  );
}

function timestampMillis(value) {
  if (!value) {
    return 0;
  }

  if (typeof value.toMillis === 'function') {
    return value.toMillis();
  }

  const parsed = parseDate(value);

  return parsed ? parsed.getTime() : 0;
}

function readSheet(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];

  if (!sheet) {
    return [];
  }

  return XLSX.utils
    .sheet_to_json(sheet, {
      defval: '',
      raw: true
    })
    .filter((row) =>
      Object.values(row).some(
        (value) =>
          value !== undefined &&
          value !== null &&
          String(value).trim() !== ''
      )
    )
    .map(cleanRow);
}

const excelBuffer = fs.readFileSync(xlsxPath);

const workbook = XLSX.read(excelBuffer, {
  type: 'buffer',
  cellDates: false,
  raw: true
});

const rawCollections = {};

for (const collectionName of Object.keys(collectionConfig)) {
  rawCollections[collectionName] =
    readSheet(workbook, collectionName);
}

const memberByLineUserId = new Map();

for (const member of rawCollections.members) {
  const lineUserId = String(
    member.lineUserId || ''
  ).trim();

  if (!lineUserId) {
    continue;
  }

  const existing =
    memberByLineUserId.get(lineUserId);

  if (!existing) {
    memberByLineUserId.set(lineUserId, member);
    continue;
  }

  const existingTime = Math.max(
    timestampMillis(existing.updatedAt),
    timestampMillis(existing.lastVisitAt),
    timestampMillis(existing.createdAt)
  );

  const incomingTime = Math.max(
    timestampMillis(member.updatedAt),
    timestampMillis(member.lastVisitAt),
    timestampMillis(member.createdAt)
  );

  if (incomingTime >= existingTime) {
    memberByLineUserId.set(lineUserId, member);
  }
}

rawCollections.members =
  [...memberByLineUserId.values()];

const lineUserIdByMemberId = new Map();

for (const member of rawCollections.members) {
  if (member.memberId && member.lineUserId) {
    lineUserIdByMemberId.set(
      String(member.memberId),
      String(member.lineUserId)
    );
  }
}

for (const collectionName of [
  'walletLogs',
  'staffLogs',
  'broadcastTargets',
  'memberCoupons',
  'pointLogs'
]) {
  rawCollections[collectionName] =
    rawCollections[collectionName].map((row) => {
      if (
        !row.lineUserId &&
        row.memberId &&
        lineUserIdByMemberId.has(
          String(row.memberId)
        )
      ) {
        row.lineUserId =
          lineUserIdByMemberId.get(
            String(row.memberId)
          );
      }

      return row;
    });
}

const prepared = {};
const warnings = [];

for (const [
  collectionName,
  config
] of Object.entries(collectionConfig)) {
  const seen = new Set();
  const documents = [];

  for (const row of rawCollections[collectionName]) {
    let documentId = String(
      row[config.primary] || ''
    ).trim();

    if (!documentId) {
      documentId = stableId(
        collectionName,
        row
      );

      warnings.push({
        type: 'generated_id',
        collection: collectionName,
        documentId
      });
    }

    if (seen.has(documentId)) {
      warnings.push({
        type: 'duplicate_document_id',
        collection: collectionName,
        documentId
      });

      continue;
    }

    seen.add(documentId);

    documents.push({
      id: documentId,
      data: {
        ...row,
        migrationSource: 'google_sheet_xlsx',
        migrationProject: PROJECT_ID,
        migrationVersion: 1
      }
    });
  }

  prepared[collectionName] = documents;
}

const preview = {
  projectId: PROJECT_ID,
  mode: execute ? 'execute' : 'dry-run',
  generatedAt: new Date().toISOString(),
  adminsTouched: false,
  counts: Object.fromEntries(
    Object.entries(prepared).map(
      ([name, documents]) => [
        name,
        documents.length
      ]
    )
  ),
  warnings,
  memberDocumentId: 'lineUserId',
  collections: Object.fromEntries(
    Object.entries(prepared).map(
      ([name, documents]) => [
        name,
        documents.slice(0, 3).map(
          (document) => document.id
        )
      ]
    )
  )
};

fs.writeFileSync(
  path.join(root, 'migration-preview.json'),
  JSON.stringify(preview, null, 2)
);

console.log(
  JSON.stringify(preview, null, 2)
);

if (dryRun) {
  console.log('');
  console.log('Dry run 完成，Firebase 寫入 0 筆');
  process.exit(0);
}

const targetCollections =
  Object.keys(collectionConfig);

for (const collectionName of targetCollections) {
  const snapshot = await db
    .collection(collectionName)
    .limit(1)
    .get();

  if (!snapshot.empty) {
    throw new Error(
      `${collectionName} 已有資料，為避免覆蓋已停止`
    );
  }
}

let totalWritten = 0;

for (const [
  collectionName,
  documents
] of Object.entries(prepared)) {
  for (
    let index = 0;
    index < documents.length;
    index += 400
  ) {
    const chunk =
      documents.slice(index, index + 400);

    const batch = db.batch();

    for (const document of chunk) {
      const reference = db
        .collection(collectionName)
        .doc(document.id);

      batch.set(reference, document.data);
    }

    await batch.commit();
    totalWritten += chunk.length;

    console.log(
      `${collectionName}：${Math.min(
        index + chunk.length,
        documents.length
      )}/${documents.length}`
    );
  }
}

await db
  .collection('migrationMeta')
  .doc('google-sheet-initial-import')
  .set({
    projectId: PROJECT_ID,
    importedAt: FieldValue.serverTimestamp(),
    sourceFile: '會員系統資料庫.xlsx',
    counts: preview.counts,
    warningCount: warnings.length,
    adminsTouched: false,
    migrationVersion: 1
  });

const result = {
  ...preview,
  totalWritten,
  completedAt: new Date().toISOString()
};

fs.writeFileSync(
  path.join(root, 'migration-result.json'),
  JSON.stringify(result, null, 2)
);

console.log('');
console.log(`正式匯入完成：${totalWritten} 筆`);
console.log('admins collection 未讀取、未修改');
