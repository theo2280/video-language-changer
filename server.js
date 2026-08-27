require("dotenv").config();
const path = require("path");
const fs = require("fs");
const os = require("os");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { randomUUID } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.resolve(__dirname, "public");
const TMP_DIR = path.join(os.tmpdir(), "vlc-uploads");
fs.mkdirSync(TMP_DIR, { recursive: true });

const PI_API_BASE = process.env.PI_API_BASE || "https://api.minepi.com/v2";
const PI_API_KEY_MAINNET = process.env.PI_API_KEY_MAINNET || "";
const PI_API_KEY_TESTNET = process.env.PI_API_KEY_TESTNET || "";
const ALLOW_DEV_FALLBACK = process.env.ALLOW_DEV_FALLBACK === "true";

const store = {
  users: new Map(),
  payments: new Map(),
  refunds: new Map(),
  subscriptions: new Map()
};

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TMP_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "") || ".mp4";
      cb(null, `${Date.now()}-${randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

function cleanupUpload(file) {
  if (file && file.path && fs.existsSync(file.path)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
  }
}

function apiKeyFor(network) {
  if (network === "testnet") return PI_API_KEY_TESTNET;
  return PI_API_KEY_MAINNET;
}

async function piFetch(pathname, { method = "GET", network = "mainnet", accessToken, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  } else {
    const key = apiKeyFor(network);
    if (!key) {
      const err = new Error(`Clé API Pi manquante pour ${network}`);
      err.code = "NO_API_KEY";
      throw err;
    }
    headers.Authorization = `Key ${key}`;
  }

  const res = await fetch(`${PI_API_BASE}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error(data?.error_message || data?.message || `Pi API ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function planDays(plan = "") {
  if (String(plan).includes("30")) return 30;
  if (String(plan).includes("7")) return 7;
  return 1;
}

function saveSubscription(uid, plan, network, paymentId) {
  const days = planDays(plan);
  const sub = {
    uid, plan, network, paymentId,
    activatedAt: Date.now(),
    expiresAt: Date.now() + days * 86400000
  };
  store.subscriptions.set(uid, sub);
  return sub;
}

app.post("/api/authenticate", (req, res) => {
  const { user, accessToken } = req.body || {};
  if (user && user.uid) {
    console.log("==========================================");
    console.log("=== UID RÉCUPÉRÉ :", user.uid);
    console.log("=== USERNAME :", user.username);
    if (accessToken) console.log("=== ACCESS TOKEN reçu");
    console.log("==========================================");

    store.users.set(user.uid, {
      ...user,
      accessToken: accessToken || null,
      lastSeen: Date.now()
    });

    return res.status(200).json({ success: true, uid: user.uid });
  }
  return res.status(400).json({ error: "UID non trouvé" });
});

app.post("/api/pi/me", async (req, res) => {
  try {
    const { accessToken, network = "mainnet" } = req.body || {};
    if (!accessToken) return res.status(400).json({ error: "accessToken requis" });

    let user;
    try {
      user = await piFetch("/me", { accessToken, network });
    } catch (e) {
      if (ALLOW_DEV_FALLBACK && e.code === "NO_API_KEY") {
        user = { uid: "dev-uid", username: "dev_pioneer" };
      } else { throw e; }
    }

    store.users.set(user.uid || user.username, { ...user, network, lastSeen: Date.now() });
    return res.json({ ok: true, user });
  } catch (err) {
    return res.status(err.status || 500).json({ error: "Vérification utilisateur échouée", detail: err.message });
  }
});

app.post("/api/pi/approve", async (req, res) => {
  try {
    const { paymentId, network = "mainnet", orderId, plan, amount, accessToken } = req.body || {};
    if (!paymentId) return res.status(400).json({ error: "paymentId requis" });

    let approved;
    try {
      approved = await piFetch(`/payments/${paymentId}/approve`, { method: "POST", network });
    } catch (e) {
      if (ALLOW_DEV_FALLBACK && e.code === "NO_API_KEY") {
        approved = { identifier: paymentId, status: "approved_dev" };
      } else { throw e; }
    }

    store.payments.set(paymentId, { paymentId, network, orderId, plan, amount, status: "approved", accessToken: accessToken || null, updatedAt: Date.now() });
    return res.status(200).json({ ok: true, payment: approved });
  } catch (err) {
    return res.status(err.status || 500).json({ error: "Approbation refusée", detail: err.message });
  }
});

app.post("/api/pi/complete", async (req, res) => {
  try {
    const { paymentId, txid, plan, network = "mainnet", orderId, accessToken } = req.body || {};
    if (!paymentId) return res.status(400).json({ error: "paymentId requis" });

    let completed;
    try {
      completed = await piFetch(`/payments/${paymentId}/complete`, { method: "POST", network, body: { txid } });
    } catch (e) {
      if (ALLOW_DEV_FALLBACK && e.code === "NO_API_KEY") {
        completed = { identifier: paymentId, transaction: { txid }, status: "completed_dev" };
      } else { throw e; }
    }

    const prev = store.payments.get(paymentId) || {};
    const record = { ...prev, paymentId, txid, plan: plan || prev.plan, network, orderId: orderId || prev.orderId, status: "completed", accessToken: accessToken || prev.accessToken || null, updatedAt: Date.now() };
    store.payments.set(paymentId, record);

    let uid = null;
    if (accessToken) {
      try {
        const me = await piFetch("/me", { accessToken, network });
        uid = me.uid || me.username;
      } catch (_) {}
    }
    if (!uid && completed?.user_uid) uid = completed.user_uid;
    if (uid && record.plan) saveSubscription(uid, record.plan, network, paymentId);

    return res.status(200).json({ ok: true, payment: completed, subscription: uid ? store.subscriptions.get(uid) : null });
  } catch (err) {
    return res.status(err.status || 500).json({ error: "Confirmation refusée", detail: err.message });
  }
});

app.post("/api/pi/refund", async (req, res) => {
  try {
    const { accessToken, network = "mainnet", username, uid, paymentId, txid, amount, plan, reason = "litige" } = req.body || {};
    if (!accessToken && !uid) return res.status(400).json({ error: "accessToken ou uid requis" });

    let userUid = uid;
    let userName = username;
    if (accessToken) {
      try {
        const me = await piFetch("/me", { accessToken, network });
        userUid = me.uid || me.username;
        userName = me.username || username;
      } catch (e) {
        if (!(ALLOW_DEV_FALLBACK && e.code === "NO_API_KEY")) throw e;
        userUid = userUid || "dev-uid";
        userName = userName || "dev_pioneer";
      }
    }

    if (paymentId && store.refunds.has(paymentId)) {
      return res.status(409).json({ error: "Remboursement déjà effectué pour ce paiement", refund: store.refunds.get(paymentId) });
    }

    const original = paymentId ? store.payments.get(paymentId) : null;
    const refundAmount = Number(amount || original?.amount || 0);

    if (!refundAmount || refundAmount <= 0) return res.status(400).json({ error: "Montant de remboursement invalide" });

    const memo = `Remboursement VLC · ${reason} · ${plan || "abonnement"} · ${network}`;

    let a2u;
    try {
      a2u = await piFetch("/payments", {
        method: "POST", network,
        body: { payment: { amount: refundAmount, memo, metadata: { type: "refund", reason, originalPaymentId: paymentId || null, originalTxid: txid || null, product: "Video Language Changer" }, uid: userUid } }
      });
    } catch (e) {
      if (ALLOW_DEV_FALLBACK && e.code === "NO_API_KEY") {
        a2u = { identifier: "dev-refund-" + Date.now(), amount: refundAmount, status: "pending_dev", transaction: { txid: "dev-txid-" + Date.now() } };
      } else { throw e; }
    }

    const refundRecord = {
      refundPaymentId: a2u.identifier || a2u.paymentId,
      originalPaymentId: paymentId || null,
      amount: refundAmount, reason, network, uid: userUid, username: userName,
      txid: a2u.transaction?.txid || null, status: a2u.status || "created", createdAt: Date.now()
    };

    if (paymentId) store.refunds.set(paymentId, refundRecord);
    store.refunds.set(refundRecord.refundPaymentId, refundRecord);
    if (userUid && store.subscriptions.has(userUid)) store.subscriptions.delete(userUid);

    return res.status(200).json({ ok: true, refund: refundRecord, txid: refundRecord.txid, message: "Remboursement A2U initié" });
  } catch (err) {
    return res.status(err.status || 500).json({ error: "Remboursement refusé", detail: err.message });
  }
});

app.post("/api/detect-language", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier vidéo requis" });
  try {
    return res.status(200).json({ language: "fr", confidence: "élevée (stub)", note: "Whisper ou STT" });
  } finally { cleanupUpload(req.file); }
});

function sendVideoFile(req, res, filename) {
  if (!req.file) return res.status(400).json({ error: "Fichier vidéo requis" });
  try {
    const buf = fs.readFileSync(req.file.path);
    const out = buf.slice(0, Math.min(buf.length, 1024 * 256));
    res.status(200);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${filename || "result.mp4"}"`);
    res.setHeader("Content-Length", out.length);
    return res.send(out);
  } catch (e) {
    return res.status(500).json({ error: e.message || "Erreur traitement vidéo" });
  } finally { cleanupUpload(req.file); }
}

app.post("/api/translate-video", upload.single("video"), (req, res) => sendVideoFile(req, res, `video-translate.mp4`));
app.post("/api/dub-video", upload.single("video"), (req, res) => sendVideoFile(req, res, `video-dub.mp4`));

app.post("/api/create-subtitles", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier vidéo requis" });
  try {
    const lang = (req.body && req.body.targetLanguage) || "fr";
    const srt = `1\n00:00:00,000 --> 00:00:05,000\n[Sous-titres — ${lang}]\n\n2\n00:00:05,000 --> 00:00:10,000\nVideo Language Changer.\n`;
    res.status(200);
    res.setHeader("Content-Type", "application/x-subrip; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="subtitles-${lang}.srt"`);
    return res.send(srt);
  } finally { cleanupUpload(req.file); }
});

app.get("/api/health", (_req, res) => {
  res.status(200).json({ ok: true, publicDir: PUBLIC_DIR });
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  return res.status(404).send("index.html manquant dans /public");
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
