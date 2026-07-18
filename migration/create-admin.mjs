import fs from 'node:fs';
import {
  cert,
  getApps,
  initializeApp
} from 'firebase-admin/app';
import {
  FieldValue,
  getFirestore
} from 'firebase-admin/firestore';
import {
  getAuth
} from 'firebase-admin/auth';

const PROJECT_ID = 'stressrelief2-f3345';
const ADMIN_UID = '8dOVCKcMhZV13t96MhLsMqyI0pW2';
const KEY_FILE = './serviceAccountKey.json';

if (!fs.existsSync(KEY_FILE)) {
  throw new Error('找不到 serviceAccountKey.json');
}

const serviceAccount = JSON.parse(
  fs.readFileSync(KEY_FILE, 'utf8')
);

if (serviceAccount.project_id !== PROJECT_ID) {
  throw new Error(
    `金鑰屬於 ${serviceAccount.project_id}，不是 ${PROJECT_ID}`
  );
}

if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount),
    projectId: PROJECT_ID
  });
}

const auth = getAuth();
const db = getFirestore();

let authUser;

try {
  authUser = await auth.getUser(ADMIN_UID);
} catch (error) {
  if (error?.code === 'auth/user-not-found') {
    throw new Error(
      `Firebase Authentication 找不到 UID：${ADMIN_UID}`
    );
  }

  throw error;
}

if (authUser.disabled) {
  throw new Error('這個管理員 Authentication 帳號目前已停用');
}

await auth.setCustomUserClaims(ADMIN_UID, {
  ...(authUser.customClaims || {}),
  admin: true,
  role: 'admin'
});

const adminRef = db
  .collection('admins')
  .doc(ADMIN_UID);

const existingAdmin = await adminRef.get();

const adminData = {
  uid: ADMIN_UID,
  email: authUser.email || '',
  displayName: authUser.displayName || '',
  role: 'admin',
  active: true,
  projectId: PROJECT_ID,
  updatedAt: FieldValue.serverTimestamp()
};

if (!existingAdmin.exists) {
  adminData.createdAt = FieldValue.serverTimestamp();
}

await adminRef.set(adminData, {
  merge: true
});

console.log('================================');
console.log('✅ 新 Firebase 管理員建立完成');
console.log(`Project：${PROJECT_ID}`);
console.log(`UID：${ADMIN_UID}`);
console.log(`Email：${authUser.email || '(沒有 Email)'}`);
console.log('Firestore：admins/' + ADMIN_UID);
console.log('Custom Claim：admin = true');
console.log('================================');
