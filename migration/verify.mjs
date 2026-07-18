import fs from 'node:fs';
import {
  cert,
  getApps,
  initializeApp
} from 'firebase-admin/app';
import {
  getFirestore
} from 'firebase-admin/firestore';
import {
  getAuth
} from 'firebase-admin/auth';

const PROJECT_ID = 'stressrelief2-f3345';
const ADMIN_UID = '8dOVCKcMhZV13t96MhLsMqyI0pW2';
const KEY_FILE = './serviceAccountKey.json';

const expectedCounts = {
  members: 17,
  walletLogs: 20,
  staffLogs: 46,
  broadcastTargets: 1,
  broadcastLogs: 1,
  memberCoupons: 7,
  coupons: 2,
  activities: 0,
  pointLogs: 0,
  otps: 0
};

if (!fs.existsSync(KEY_FILE)) {
  throw new Error('找不到 serviceAccountKey.json');
}

const serviceAccount = JSON.parse(
  fs.readFileSync(KEY_FILE, 'utf8')
);

if (serviceAccount.project_id !== PROJECT_ID) {
  throw new Error(
    `金鑰專案錯誤：${serviceAccount.project_id}`
  );
}

if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount),
    projectId: PROJECT_ID
  });
}

const db = getFirestore();
const auth = getAuth();

const result = {
  projectId: PROJECT_ID,
  verifiedAt: new Date().toISOString(),
  counts: {},
  admin: {},
  problems: []
};

for (const [collectionName, expectedCount] of Object.entries(expectedCounts)) {
  const snapshot = await db
    .collection(collectionName)
    .get();

  const actualCount = snapshot.size;

  result.counts[collectionName] = {
    expected: expectedCount,
    actual: actualCount
  };

  if (actualCount !== expectedCount) {
    result.problems.push({
      type: 'count_mismatch',
      collection: collectionName,
      expected: expectedCount,
      actual: actualCount
    });
  }
}

const memberSnapshot = await db
  .collection('members')
  .get();

const seenMemberIds = new Map();
const seenLineUserIds = new Set();

for (const document of memberSnapshot.docs) {
  const member = document.data();
  const lineUserId = String(member.lineUserId || '');
  const memberId = String(member.memberId || '');

  if (!lineUserId) {
    result.problems.push({
      type: 'missing_line_user_id',
      documentId: document.id
    });
  }

  if (document.id !== lineUserId) {
    result.problems.push({
      type: 'member_document_id_mismatch',
      documentId: document.id,
      lineUserId
    });
  }

  if (seenLineUserIds.has(lineUserId)) {
    result.problems.push({
      type: 'duplicate_line_user_id',
      lineUserId
    });
  } else {
    seenLineUserIds.add(lineUserId);
  }

  if (!memberId) {
    result.problems.push({
      type: 'missing_member_id',
      documentId: document.id
    });
  } else if (seenMemberIds.has(memberId)) {
    result.problems.push({
      type: 'duplicate_member_id',
      memberId,
      documentIds: [
        seenMemberIds.get(memberId),
        document.id
      ]
    });
  } else {
    seenMemberIds.set(memberId, document.id);
  }
}

const migrationMeta = await db
  .collection('migrationMeta')
  .doc('google-sheet-initial-import')
  .get();

if (!migrationMeta.exists) {
  result.problems.push({
    type: 'missing_migration_meta'
  });
} else {
  result.migrationMeta = migrationMeta.data();
}

const adminDocument = await db
  .collection('admins')
  .doc(ADMIN_UID)
  .get();

if (!adminDocument.exists) {
  result.problems.push({
    type: 'missing_admin_document',
    uid: ADMIN_UID
  });
} else {
  const adminData = adminDocument.data();

  result.admin.firestore = {
    uid: adminData.uid || '',
    email: adminData.email || '',
    role: adminData.role || '',
    active: adminData.active === true
  };

  if (
    adminData.active !== true ||
    adminData.role !== 'admin'
  ) {
    result.problems.push({
      type: 'invalid_admin_document',
      uid: ADMIN_UID
    });
  }
}

try {
  const adminUser = await auth.getUser(ADMIN_UID);

  result.admin.authentication = {
    uid: adminUser.uid,
    email: adminUser.email || '',
    disabled: adminUser.disabled,
    customClaims: adminUser.customClaims || {}
  };

  if (adminUser.disabled) {
    result.problems.push({
      type: 'admin_auth_disabled',
      uid: ADMIN_UID
    });
  }

  if (adminUser.customClaims?.admin !== true) {
    result.problems.push({
      type: 'missing_admin_custom_claim',
      uid: ADMIN_UID
    });
  }
} catch (error) {
  result.problems.push({
    type: 'admin_auth_not_found',
    uid: ADMIN_UID,
    message: error.message
  });
}

result.success = result.problems.length === 0;

fs.writeFileSync(
  'verification-result.json',
  JSON.stringify(result, null, 2),
  'utf8'
);

console.log(JSON.stringify(result, null, 2));

if (!result.success) {
  process.exitCode = 1;
}
