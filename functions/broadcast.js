const admin = require("firebase-admin");

const {
  onCall,
  HttpsError,
} = require("firebase-functions/v2/https");

const {
  defineSecret,
} = require("firebase-functions/params");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

const LINE_CHANNEL_ACCESS_TOKEN =
  defineSecret("LINE_CHANNEL_ACCESS_TOKEN");

const PROJECT_ID = "stressrelief2-f3345";
const REGION = "asia-east1";
const MEMBER_FRONTEND_URL =
  "https://songyihsuan.github.io/stressrelief_2/";

function cleanString(value) {
  return String(value ?? "").trim();
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function parseFirestoreDate(value) {
  if (!value) {
    return null;
  }

  if (
    value &&
    typeof value.toDate === "function"
  ) {
    return value.toDate();
  }

  if (
    value &&
    typeof value.seconds === "number"
  ) {
    return new Date(
      value.seconds * 1000
    );
  }

  if (value instanceof Date) {
    return value;
  }

  const raw = cleanString(value);

  if (!raw) {
    return null;
  }

  const normalized = raw
    .replace(/\//g, "-")
    .replace(" ", "T");

  const date = new Date(normalized);

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

async function assertAdmin(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError(
      "unauthenticated",
      "請先登入新版後台"
    );
  }

  const uid = request.auth.uid;

  const snapshot = await db
    .collection("admins")
    .doc(uid)
    .get();

  if (!snapshot.exists) {
    throw new HttpsError(
      "permission-denied",
      "找不到後台管理員權限"
    );
  }

  const profile =
    snapshot.data() || {};

  if (profile.active !== true) {
    throw new HttpsError(
      "permission-denied",
      "此後台帳號尚未啟用"
    );
  }

  if (
    profile.projectId &&
    profile.projectId !== PROJECT_ID
  ) {
    throw new HttpsError(
      "permission-denied",
      "管理員不屬於新版 Firebase 專案"
    );
  }

  return {
    uid,
    email:
      request.auth.token.email ||
      profile.email ||
      "",
    displayName:
      profile.displayName ||
      profile.storeName ||
      "",
    profile,
  };
}

async function getBroadcastWalletSpendTotals(members) {
  const identityOwners = new Map();
  const totals = new Map();

  function registerIdentity(identity, canonicalId) {
    const key = cleanString(identity);

    if (!key) return;

    const existing = identityOwners.get(key);

    if (existing && existing !== canonicalId) {
      throw new HttpsError(
        "failed-precondition",
        "會員識別存在重複歸屬，請先檢查會員資料"
      );
    }

    identityOwners.set(key, canonicalId);
  }

  for (const member of members) {
    const canonicalId = cleanString(member.documentId);

    if (!canonicalId) {
      throw new HttpsError(
        "failed-precondition",
        "會員缺少 Firestore 文件 ID"
      );
    }

    registerIdentity(canonicalId, canonicalId);
    registerIdentity(member.lineUserId, canonicalId);
    totals.set(canonicalId, 0);
  }

  const snapshot = await db
    .collection("walletLogs")
    .get();

  let unmatchedCount = 0;

  snapshot.forEach((doc) => {
    const log = doc.data() || {};
    const amount = Number(log.amount);

    if (
      cleanString(log.type) !== "使用" ||
      !Number.isFinite(amount) ||
      amount >= 0
    ) {
      return;
    }

    const identities = [
      log.memberDocumentId,
      log.lineUserId,
    ]
      .map(cleanString)
      .filter(Boolean);

    const owners = new Set();

    for (const identity of identities) {
      const owner = identityOwners.get(identity);
      if (owner) owners.add(owner);
    }

    if (owners.size > 1) {
      throw new HttpsError(
        "failed-precondition",
        "消費紀錄的會員識別互相衝突，請先檢查資料"
      );
    }

    if (owners.size === 0) {
      unmatchedCount++;
      return;
    }

    const canonicalId = [...owners][0];

    // 每筆 walletLog 只加總一次
    totals.set(
      canonicalId,
      (totals.get(canonicalId) || 0) - amount
    );
  });

  if (unmatchedCount > 0) {
    throw new HttpsError(
      "failed-precondition",
      "有 " + unmatchedCount +
      " 筆歷史使用紀錄無法對應會員，為避免篩選錯誤已停止預覽"
    );
  }

  return totals;
}

function memberMatchesFilters(
  member,
  filters
) {
  const level =
    cleanString(filters.level);

  const tag =
    cleanString(filters.tag)
      .toLowerCase();

  const minStoredValue =
    finiteNumber(
      filters.minStoredValue,
      0
    );

  const hasStoredValue =
    cleanString(
      filters.hasStoredValue
    );

  const joinedAfterDate =
    cleanString(
      filters.joinedAfterDate
    );

  const hasTotalSpend =
    cleanString(filters.hasTotalSpend);

  const totalSpend =
    finiteNumber(member.broadcastActualSpend, 0);

  if (hasTotalSpend !== "") {
    const minTotalSpend = Number(hasTotalSpend);

    if (
      !Number.isFinite(minTotalSpend) ||
      minTotalSpend < 0 ||
      totalSpend < minTotalSpend
    ) {
      return false;
    }
  }

  if (
    level &&
    cleanString(member.level) !== level
  ) {
    return false;
  }

  if (tag) {
    const memberTags =
      cleanString(member.tags)
        .split(",")
        .map((item) =>
          item.trim().toLowerCase()
        )
        .filter(Boolean);

    if (!memberTags.includes(tag)) {
      return false;
    }
  }

  const storedValue =
    finiteNumber(
      member.storedValue,
      0
    );

  if (
    minStoredValue > 0 &&
    storedValue < minStoredValue
  ) {
    return false;
  }

  if (
    hasStoredValue === "yes" &&
    storedValue <= 0
  ) {
    return false;
  }

  if (
    hasStoredValue === "no" &&
    storedValue > 0
  ) {
    return false;
  }

  if (joinedAfterDate) {
    const createdAt =
      parseFirestoreDate(
        member.createdAt
      );

    if (!createdAt) {
      return false;
    }

    const joinedStart =
      new Date(
        joinedAfterDate +
        "T00:00:00+08:00"
      );

    if (
      Number.isNaN(
        joinedStart.getTime()
      ) ||
      createdAt < joinedStart
    ) {
      return false;
    }
  }

  return true;
}

function validateHttpsUrl(
  value,
  fieldName
) {
  const raw = cleanString(value);

  if (!raw) {
    return "";
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName}格式不正確`
    );
  }

  if (
    url.protocol !== "https:" &&
    url.protocol !== "http:"
  ) {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName}必須是網址`
    );
  }

  return url.toString();
}

function buildFlexMessage({
  sendType,
  title,
  content,
  imageUrl,
  actionUrl,
  buttonLabel,
}) {
  const safeTitle =
    title ||
    (
      sendType === "coupon"
        ? "解憂藥局優惠券"
        : "解憂藥局會員通知"
    );

  const safeContent =
    content ||
    (
      sendType === "coupon"
        ? "點擊下方按鈕查看會員優惠券。"
        : "會員專屬通知"
    );

  const safeButtonLabel =
    buttonLabel ||
    (
      sendType === "coupon"
        ? "立即領取優惠券"
        : "查看詳情"
    );

  const bodyContents = [
    {
      type: "text",
      text: safeTitle,
      weight: "bold",
      size: "xl",
      wrap: true,
      color: "#111827",
    },
    {
      type: "text",
      text: safeContent,
      size: "sm",
      wrap: true,
      color: "#475569",
      margin: "md",
    },
  ];

  if (actionUrl) {
    bodyContents.push({
      type: "button",
      style: "primary",
      color: "#111827",
      margin: "lg",
      action: {
        type: "uri",
        label:
          safeButtonLabel.slice(0, 20),
        uri: actionUrl,
      },
    });
  }

  const bubble = {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: bodyContents,
      paddingAll: "20px",
    },
  };

  if (imageUrl) {
    bubble.hero = {
      type: "image",
      url: imageUrl,
      size: "full",
      aspectRatio: "20:13",
      aspectMode: "cover",
    };
  }

  return {
    type: "flex",
    altText:
      safeTitle.slice(0, 400),
    contents: bubble,
  };
}

async function lineMulticast({
  token,
  userIds,
  messages,
}) {
  const response = await fetch(
    "https://api.line.me/v2/bot/message/multicast",
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${token}`,
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify({
        to: userIds,
        messages,
      }),
    }
  );

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `LINE multicast 失敗：` +
      `${response.status} ` +
      responseText
    );
  }
}

async function createCouponForMembers({
  payload,
  targets,
  adminInfo,
}) {
  const couponRef =
    db.collection("coupons").doc();

  const couponId =
    couponRef.id;

  const title =
    cleanString(payload.title) ||
    "解憂藥局優惠券";

  const content =
    cleanString(payload.content) ||
    "會員專屬優惠券";

  const amount =
    finiteNumber(
      payload.couponAmount,
      0
    );

  const startDate =
    cleanString(
      payload.couponStartDate
    );

  const endDate =
    cleanString(
      payload.couponEndDate
    );

  const now =
    admin.firestore
      .FieldValue
      .serverTimestamp();

  await couponRef.set({
    couponId,
    title,
    content,
    description: content,
    imageUrl:
      cleanString(payload.imageUrl),
    amount,
    discountAmount: amount,
    startDate,
    endDate,
    active: true,
    createdBy:
      adminInfo.uid,
    createdByEmail:
      adminInfo.email,
    storeName:
      adminInfo.displayName,
    createdAt: now,
    updatedAt: now,
  });

  const rows = targets.map(
    (target) => ({
      target,
      ref:
        db.collection(
          "memberCoupons"
        ).doc(),
    })
  );

  for (
    let start = 0;
    start < rows.length;
    start += 400
  ) {
    const batch =
      db.batch();

    const portion =
      rows.slice(
        start,
        start + 400
      );

    portion.forEach(
      ({ target, ref }) => {
        batch.set(ref, {
          memberCouponId:
            ref.id,
          couponId,
          memberId:
            cleanString(
              target.memberId
            ),
          memberDocumentId:
            target.documentId ||
            target.lineUserId ||
            "",
          lineUserId:
            cleanString(
              target.lineUserId
            ),
          displayName:
            cleanString(
              target.displayName
            ),
          status: "unused",
          claimed: true,
          claimedAt: now,
          usedAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }
    );

    await batch.commit();
  }

  return {
    couponId,
    actionUrl:
      MEMBER_FRONTEND_URL +
      "?couponId=" +
      encodeURIComponent(couponId),
  };
}


/*
 * STEP 8B
 * 伺服器端群發預覽
 * 僅計算名單，不呼叫 LINE API。
 */

const BROADCAST_PREVIEW_TTL_MS = 10 * 60 * 1000;

function validateBroadcastSpendFilter(payload) {
  const value = cleanString(payload.hasTotalSpend);

  if (value !== "") {
    const number = Number(value);

    if (!Number.isFinite(number) || number < 0) {
      throw new HttpsError(
        "invalid-argument",
        "累積消費金額必須是非負數"
      );
    }
  }
}

function broadcastFilterSignature(payload) {
  const crypto = require("crypto");

  const filters = {
    level: cleanString(payload.level),
    tag: cleanString(payload.tag).toLowerCase(),
    minStoredValue: finiteNumber(
      payload.minStoredValue, 0
    ),
    joinedAfterDate: cleanString(
      payload.joinedAfterDate
    ),
    hasStoredValue: cleanString(
      payload.hasStoredValue
    ),
    hasTotalSpend: cleanString(
      payload.hasTotalSpend
    ),
  };

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(filters))
    .digest("hex");
}


// STEP8I_PREVIEW_ONLY
// 預覽測試期間禁止所有正式 LINE 群發。
const STEP8I_PREVIEW_ONLY = false;

// STEP8M_F_PREVIEW_READY
exports.previewBroadcast = onCall(
  {
    region: REGION,
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (request) => {
    const adminInfo = await assertAdmin(request);

    const payload = request.data || {};

    validateBroadcastSpendFilter(payload);

    const snapshot = await db
      .collection("members")
      .get();

    const members = snapshot.docs.map((document) => ({
      ...document.data(),
      documentId: document.id,
    }));

    const walletTotals =
      cleanString(payload.hasTotalSpend) !== ""
        ? await getBroadcastWalletSpendTotals(members)
        : new Map();

    const candidates = members.map((member) => ({
      ...member,
      broadcastActualSpend: walletTotals.get(cleanString(member.documentId)) || 0,
    }));

    const targets = candidates.filter((member) =>
      memberMatchesFilters(member, payload) &&
      cleanString(member.lineUserId)
    );

    const ids = targets.map((member) =>
      cleanString(member.lineUserId)
    );

    if (new Set(ids).size !== ids.length) {
      throw new HttpsError(
        "failed-precondition",
        "會員 LINE ID 存在重複，請先整理會員資料"
      );
    }

    if (targets.length > 5000) {
      throw new HttpsError(
        "resource-exhausted",
        "預覽超過 5000 人，請縮小篩選條件"
      );
    }

    const previewRef = db
      .collection("broadcastPreviews")
      .doc();

    const now = Date.now();

    await previewRef.set({
      operatorUid: adminInfo.uid,
      filterSignature:
        broadcastFilterSignature(payload),
      memberIds: ids,
      count: ids.length,
      status: "ready",
      createdAt:
        admin.firestore.FieldValue.serverTimestamp(),
      expiresAtMs:
        now + BROADCAST_PREVIEW_TTL_MS,
    });

    return {
      previewId: previewRef.id,
      count: targets.length,
      members: targets.map((member) => ({
        documentId: member.documentId,
        memberId: member.memberId || "",
        lineUserId: member.lineUserId || "",
        displayName: member.displayName || "",
        level: member.level || "",
        storedValue: member.storedValue || 0,
        totalSpend: member.broadcastActualSpend || 0,
        tags: member.tags || "",
        createdAt: parseFirestoreDate(member.createdAt)
          ?.toISOString() || "",
      })),
    };
  }
);

exports.sendBroadcast = onCall(
  {
    region: REGION,
    secrets: [
      LINE_CHANNEL_ACCESS_TOKEN,
    ],
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (request) => {
    const adminInfo =
      await assertAdmin(request);

    // STEP8I_PREVIEW_ONLY：伺服器端強制停用發送。
    if (STEP8I_PREVIEW_ONLY) {
      throw new HttpsError(
        "failed-precondition",
        "目前僅開放預覽名單，正式 LINE 群發已停用"
      );
    }


    const payload =
      request.data || {};

    validateBroadcastSpendFilter(payload);

    const sendType =
      cleanString(
        payload.sendType
      ) || "imageText";

    if (
      sendType !== "imageText" &&
      sendType !== "coupon"
    ) {
      throw new HttpsError(
        "invalid-argument",
        "不支援的發送類型"
      );
    }

    const title =
      cleanString(payload.title);

    const content =
      cleanString(payload.content);

    if (!title && !content) {
      throw new HttpsError(
        "invalid-argument",
        "請至少輸入標題或內容"
      );
    }

    const imageUrl =
      validateHttpsUrl(
        payload.imageUrl,
        "圖片網址"
      );

    let actionUrl =
      validateHttpsUrl(
        payload.actionUrl,
        "按鈕網址"
      );

    const membersSnapshot =
      await db
        .collection("members")
        .get();

    const allMembers =
      membersSnapshot.docs.map(
        (document) => ({
          ...document.data(),
          documentId: document.id,
        })
      );

    const walletSpendTotals =
      cleanString(payload.hasTotalSpend) !== ""
        ? await getBroadcastWalletSpendTotals(allMembers)
        : new Map();

    const membersWithActualSpend =
      allMembers.map((member) => ({
        ...member,
        broadcastActualSpend: walletSpendTotals.get(cleanString(member.documentId)) || 0,
      }));

    const targets =
      membersWithActualSpend.filter(
        (member) => {
          return (
            memberMatchesFilters(
              member,
              payload
            ) &&
            cleanString(
              member.lineUserId
            )
          );
        }
      );

    const previewMemberIds =
      payload.previewMemberIds;

    if (
      !cleanString(payload.previewId) ||
      !Array.isArray(previewMemberIds) ||
      previewMemberIds.length === 0 ||
      previewMemberIds.length > 100000 ||
      previewMemberIds.some(
        id => typeof id !== "string" || !id.trim()
      )
    ) {
      throw new HttpsError(
        "failed-precondition",
        "請先重新預覽有效的 LINE 會員名單"
      );
    }

    const expectedIds = new Set(previewMemberIds);
    const actualIds = new Set(
      targets.map(member => cleanString(member.lineUserId))
    );

    if (
      expectedIds.size !== previewMemberIds.length ||
      actualIds.size !== expectedIds.size ||
      [...expectedIds].some(id => !actualIds.has(id))
    ) {
      throw new HttpsError(
        "failed-precondition",
        "會員名單或篩選結果已變更，請重新預覽後再發送"
      );
    }

    if (!targets.length) {
      throw new HttpsError(
        "failed-precondition",
        "沒有符合條件且已綁定 LINE 的會員"
      );
    }


    const previewId = cleanString(payload.previewId);

    if (!/^[A-Za-z0-9_-]{10,100}$/.test(previewId)) {
      throw new HttpsError(
        "failed-precondition",
        "預覽編號無效，請重新預覽"
      );
    }

    const previewRef = db
      .collection("broadcastPreviews")
      .doc(previewId);

    const currentSignature =
      broadcastFilterSignature(payload);

    await db.runTransaction(async (transaction) => {
      const snapshot =
        await transaction.get(previewRef);

      if (!snapshot.exists) {
        throw new HttpsError(
          "failed-precondition",
          "找不到伺服器端預覽紀錄"
        );
      }

      const saved = snapshot.data() || {};

      if (
        saved.operatorUid !== adminInfo.uid ||
        saved.status !== "ready" ||
        !Number.isFinite(saved.expiresAtMs) ||
        Date.now() >= saved.expiresAtMs ||
        saved.filterSignature !== currentSignature
      ) {
        throw new HttpsError(
          "failed-precondition",
          "預覽已過期、已使用或條件已變更，請重新預覽"
        );
      }

      const storedIds = saved.memberIds || [];

      if (
        !Array.isArray(storedIds) ||
        storedIds.length !== actualIds.size ||
        storedIds.length !== expectedIds.size ||
        new Set(storedIds).size !== storedIds.length ||
        storedIds.some(id => !actualIds.has(id)) ||
        storedIds.some(id => !expectedIds.has(id))
      ) {
        throw new HttpsError(
          "failed-precondition",
          "伺服器預覽名單與目前會員名單不一致"
        );
      }

      transaction.update(previewRef, {
        status: "sending",
        sendingStartedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    let couponId = "";

    if (sendType === "coupon") {
      const couponResult =
        await createCouponForMembers({
          payload,
          targets,
          adminInfo,
        });

      couponId =
        couponResult.couponId;

      actionUrl =
        couponResult.actionUrl;
    }

    const message =
      buildFlexMessage({
        sendType,
        title,
        content,
        imageUrl,
        actionUrl,
        buttonLabel:
          cleanString(
            payload.buttonLabel
          ),
      });

    const token =
      LINE_CHANNEL_ACCESS_TOKEN
        .value();

    if (!token) {
      throw new HttpsError(
        "failed-precondition",
        "尚未設定 LINE_CHANNEL_ACCESS_TOKEN"
      );
    }

    const userIds = [
      ...new Set(
        targets.map((member) =>
          cleanString(
            member.lineUserId
          )
        )
      ),
    ];

    let sentCount = 0;
    const errors = [];

    for (
      let start = 0;
      start < userIds.length;
      start += 500
    ) {
      const portion =
        userIds.slice(
          start,
          start + 500
        );

      try {
        await lineMulticast({
          token,
          userIds: portion,
          messages: [message],
        });

        sentCount +=
          portion.length;
      } catch (error) {
        errors.push({
          start,
          count:
            portion.length,
          message:
            error.message ||
            String(error),
        });
      }
    }

    const logRef =
      db.collection(
        "broadcastLogs"
      ).doc();

    await logRef.set({
      broadcastId:
        logRef.id,
      previewId:
        cleanString(
          payload.previewId
        ),
      sendType,
      title,
      content,
      imageUrl,
      actionUrl,
      buttonLabel:
        cleanString(
          payload.buttonLabel
        ),
      couponId,
      filters: {
        level:
          cleanString(payload.level),
        tag:
          cleanString(payload.tag),
        minStoredValue:
          finiteNumber(
            payload.minStoredValue,
            0
          ),
        joinedAfterDate:
          cleanString(
            payload.joinedAfterDate
          ),
        hasStoredValue:
          cleanString(
            payload.hasStoredValue
          ),
        hasTotalSpend:
          cleanString(
            payload.hasTotalSpend
          ),
      },
      targetCount:
        userIds.length,
      sentCount,
      failedCount:
        userIds.length -
        sentCount,
      errors,
      operatorUid:
        adminInfo.uid,
      operatorEmail:
        adminInfo.email,
      storeName:
        adminInfo.displayName,
      createdAt:
        admin.firestore
          .FieldValue
          .serverTimestamp(),
    });

    await previewRef.update({
      status:
        sentCount === userIds.length
          ? "completed"
          : "partial_failed",
      sentCount,
      failedCount: userIds.length - sentCount,
      broadcastId: logRef.id,
      finishedAt:
        admin.firestore.FieldValue.serverTimestamp(),
    });

    if (
      sentCount === 0 &&
      errors.length
    ) {
      throw new HttpsError(
        "internal",
        errors[0].message
      );
    }

    return {
      success: true,
      broadcastId:
        logRef.id,
      couponId,
      targetCount:
        userIds.length,
      sentCount,
      failedCount:
        userIds.length -
        sentCount,
    };
  }
);
