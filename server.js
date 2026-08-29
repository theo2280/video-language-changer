/**
 * Video Language Changer — Backend Node.js (Pi Network)
 *
 * Endpoints :
 * POST /api/authenticate   — log / récupère l'UID du pionnier (debug)
 * POST /api/pi/me          — vérifie le accessToken du pionnier
 * POST /api/pi/approve     — approuve un paiement U2A
 * POST /api/pi/complete    — finalise un paiement U2A
 * POST /api/pi/refund      — remboursement A2U (App → User)
 * POST /api/detect-language, /api/translate-video, /api/dub-video, /api/create-subtitles
 *
 * Keep-Alive & Validation :
 * GET  /ping               — pour UptimeRobot (anti-sleep Render Free)
 * GET  /api/health         — health check détaillé
 * GET  /validation-key.txt — clé de validation selon Testnet / Mainnet
 *
 * Variables d'environnement : voir .env.example
 */

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

// Chemin absolu vers le dossier public
const PUBLIC_DIR = path.resolve(__dirname, "public");

const PI_API_BASE = process.env.PI_API_BASE || "https://api.minepi.com/v2";
const PI_API_KEY_MAINNET = process.env.PI_API_KEY_MAINNET || "";
const PI_API_KEY_TESTNET = process.env.PI_API_KEY_TESTNET || "";
const APP_WALLET_SEED = process.env.APP_WALLET_SEED || "";
const ALLOW_DEV_FALLBACK = process.env.ALLOW_DEV_FALLBACK === "true";

// Réseau par défaut (testnet | mainnet)
const DEFAULT_NETWORK = (process.env.PI_NETWORK || "testnet").toLowerCase();

/** Mémoire locale (remplacer par une vraie DB en production) */
const store = {
  users: new Map(),
  payments: new Map(),
  refunds: new Map(),
  subscriptions: new Map()
};

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

// Fichiers statiques
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2 Go
});

function apiKeyFor(network) {
  return network === "testnet" ? PI_API_KEY_TESTNET : PI_API_KEY_MAINNET;
}

function hasApiKey(network) {
  return Boolean(apiKeyFor(network));
}

/**
 * Détermine le réseau (testnet / mainnet) à partir de :
 * 1. Variable d'environnement PI_NETWORK
 * 2. Query ?network=testnet|mainnet
 * 3. Hostname (contient "testnet" ou "sandbox")
 */
function detectNetwork(req) {
  // 1. Query string prioritaire
  const q = (req.query.network || "").toLowerCase();
  if (q === "testnet" || q === "mainnet") return q;

  // 2. Hostname
  const host = (req.hostname || req.headers.host || "").toLowerCase();
  if (host.includes("testnet") || host.includes("sandbox") || host.includes("test")) {
    return "testnet";
  }

  // 3. Variable d'environnement
  if (DEFAULT_NETWORK === "mainnet" || DEFAULT_NETWORK === "testnet") {
    return DEFAULT_NETWORK;
  }

  // Fallback
  return "testnet";
}

// piFetch corrigé
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
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

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
    uid,
    plan,
    network,
    paymentId,
    activatedAt: Date.now(),
    expiresAt: Date.now() + days * 86400000
  };
  store.subscriptions.set(uid, sub);
  return sub;
}

/* ───────────── Keep-Alive pour UptimeRobot / Health Check ───────────── */

app.get("/ping", (req, res) => {
  res.status(200).send("OK");
});

/**
 * Route de validation Pi Network
 * Affiche UNIQUEMENT la clé correspondant au réseau détecté
 * (Testnet ou Mainnet)
 */
app.get("/validation-key.txt", (req, res) => {
  const keyTestnet =
    "2e13a98c5e0b7462e8d0d306accab3ed3f0c3d3b0568b023d69ae68c9e8fb8b2d8f59dc5e7336e3c101769c94ecd652a44a769f179f9a856a9f8731e9dcb0f8a";
  const keyMainnet =
    "3eccce22c5ac56f8e3f1f41795ae376f90bf502532f3683745a723886d037012cffd9de96aad9dfadc394ce6b068695b9ab35b907df6305ebdc4223539f6c4f8";

  const network = detectNetwork(req);
  const key = network === "mainnet" ? keyMainnet : keyTestnet;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(key);
});

/* ───────────── Debug / récupération UID ───────────── */

app.post("/api/authenticate", (req, res) => {
  const { user } = req.body || {};
  if (user && user.uid) {
    console.log("==========================================");
    console.log("=== UID RÉCUPÉRÉ :", user.uid);
    console.log("=== USERNAME :", user.username);
    console.log("==========================================");

    store.users.set(user.uid, {
      ...user,
      lastSeen: Date.now()
    });

    return res.status(200).json({ success: true, uid: user.uid });
  }
  return res.status(400).json({ error: "UID non trouvé" });
});

/* ───────────── Pi : identité ───────────── */

app.post("/api/pi/me", async (req, res) => {
  try {
    const { accessToken, network = "mainnet" } = req.body || {};
    if (!accessToken) {
      return res.status(400).json({ error: "accessToken requis" });
    }

    let user;
    try {
      user = await piFetch("/me", { accessToken, network });
    } catch (e) {
      if (ALLOW_DEV_FALLBACK && e.code === "NO_API_KEY") {
        user = { uid: "dev-uid", username: "dev_pioneer" };
      } else {
        throw e;
      }
    }

    store.users.set(user.uid || user.username, {
      ...user,
      network,
      lastSeen: Date.now()
    });

    return res.json({ ok: true, user });
  } catch (err) {
    console.error("POST /api/pi/me", err.message, err.data || "");
    return res.status(err.status || 500).json({
      error: "Vérification utilisateur échouée",
      detail: err.message
    });
  }
});

/* ───────────── Pi : approbation U2A ───────────── */

app.post("/api/pi/approve", async (req, res) => {
  try {
    const {
      paymentId,
      network = "mainnet",
      orderId,
      plan,
      amount,
      accessToken
    } = req.body || {};

    if (!paymentId) {
      return res.status(400).json({ error: "paymentId requis" });
    }

    let approved;
    try {
      approved = await piFetch(`/payments/${paymentId}/approve`, {
        method: "POST",
        network
      });
    } catch (e) {
      if (ALLOW_DEV_FALLBACK && e.code === "NO_API_KEY") {
        approved = { identifier: paymentId, status: "approved_dev" };
      } else {
        throw e;
      }
    }

    store.payments.set(paymentId, {
      paymentId,
      network,
      orderId,
      plan,
      amount,
      status: "approved",
      accessToken: accessToken || null,
      updatedAt: Date.now()
    });

    return res.json({ ok: true, payment: approved });
  } catch (err) {
    console.error("POST /api/pi/approve", err.message, err.data || "");
    return res.status(err.status || 500).json({
      error: "Approbation refusée",
      detail: err.message
    });
  }
});

/* ───────────── Pi : completion U2A ───────────── */

app.post("/api/pi/complete", async (req, res) => {
  try {
    const {
      paymentId,
      txid,
      plan,
      network = "mainnet",
      orderId,
      accessToken
    } = req.body || {};

    if (!paymentId) {
      return res.status(400).json({ error: "paymentId requis" });
    }

    let completed;
    try {
      completed = await piFetch(`/payments/${paymentId}/complete`, {
        method: "POST",
        network,
        body: { txid }
      });
    } catch (e) {
      if (ALLOW_DEV_FALLBACK && e.code === "NO_API_KEY") {
        completed = {
          identifier: paymentId,
          transaction: { txid },
          status: "completed_dev"
        };
      } else {
        throw e;
      }
    }

    const prev = store.payments.get(paymentId) || {};
    const record = {
      ...prev,
      paymentId,
      txid,
      plan: plan || prev.plan,
      network,
      orderId: orderId || prev.orderId,
      status: "completed",
      accessToken: accessToken || prev.accessToken || null,
      updatedAt: Date.now()
    };
    store.payments.set(paymentId, record);

    let uid = null;
    if (accessToken) {
      try {
        const me = await piFetch("/me", { accessToken, network });
        uid = me.uid || me.username;
      } catch (_) {}
    }
    if (!uid && completed?.user_uid) uid = completed.user_uid;

    if (uid && record.plan) {
      saveSubscription(uid, record.plan, network, paymentId);
    }

    return res.json({
      ok: true,
      payment: completed,
      subscription: uid ? store.subscriptions.get(uid) : null
    });
  } catch (err) {
    console.error("POST /api/pi/complete", err.message, err.data || "");
    return res.status(err.status || 500).json({
      error: "Confirmation refusée",
      detail: err.message
    });
  }
});

/* ───────────── Pi : remboursement A2U ───────────── */

app.post("/api/pi/refund", async (req, res) => {
  try {
    const {
      accessToken,
      network = "mainnet",
      username,
      uid,
      paymentId,
      txid,
      amount,
      plan,
      reason = "litige"
    } = req.body || {};

    if (!accessToken && !uid) {
      return res.status(400).json({ error: "accessToken ou uid requis" });
    }

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
      return res.status(409).json({
        error: "Remboursement déjà effectué pour ce paiement",
        refund: store.refunds.get(paymentId)
      });
    }

    const original = paymentId ? store.payments.get(paymentId) : null;
    const refundAmount = Number(amount || original?.amount || 0);

    if (!refundAmount || refundAmount <= 0) {
      return res.status(400).json({ error: "Montant de remboursement invalide" });
    }

    const allowed = ["echec_traduction", "litige", "echec_doublage", "echec_sous_titres"];
    if (!allowed.includes(reason) && reason !== "litige") {
      console.warn("Raison de remboursement non standard:", reason);
    }

    const memo = `Remboursement VLC · ${reason} · ${plan || "abonnement"} · ${network}`;

    let a2u;
    try {
      a2u = await piFetch("/payments", {
        method: "POST",
        network,
        body: {
          payment: {
            amount: refundAmount,
            memo,
            metadata: {
              type: "refund",
              reason,
              originalPaymentId: paymentId || null,
              originalTxid: txid || null,
              product: "Video Language Changer"
            },
            uid: userUid
          }
        }
      });
    } catch (e) {
      if (ALLOW_DEV_FALLBACK && e.code === "NO_API_KEY") {
        a2u = {
          identifier: "dev-refund-" + Date.now(),
          amount: refundAmount,
          status: "pending_dev",
          transaction: { txid: "dev-txid-" + Date.now() }
        };
      } else {
        throw e;
      }
    }

    const refundRecord = {
      refundPaymentId: a2u.identifier || a2u.paymentId,
      originalPaymentId: paymentId || null,
      amount: refundAmount,
      reason,
      network,
      uid: userUid,
      username: userName,
      txid: a2u.transaction?.txid || null,
      status: a2u.status || "created",
      createdAt: Date.now()
    };

    if (paymentId) store.refunds.set(paymentId, refundRecord);
    store.refunds.set(refundRecord.refundPaymentId, refundRecord);

    if (userUid && store.subscriptions.has(userUid)) {
      store.subscriptions.delete(userUid);
    }

    if (paymentId && store.payments.has(paymentId)) {
      const p = store.payments.get(paymentId);
      p.status = "refunded";
      p.refundedAt = Date.now();
      store.payments.set(paymentId, p);
    }

    return res.json({
      ok: true,
      refund: refundRecord,
      txid: refundRecord.txid,
      message: "Remboursement A2U initié"
    });
  } catch (err) {
    console.error("POST /api/pi/refund", err.message, err.data || "");
    return res.status(err.status || 500).json({
      error: "Remboursement refusé",
      detail: err.message,
      pi: err.data || null
    });
  }
});

/* ───────────── Traitement vidéo (stubs) ───────────── */

app.post("/api/detect-language", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Fichier vidéo requis" });
  return res.json({
    language: "fr",
    confidence: "élevée (stub)",
    note: "Remplacez ce stub par Whisper ou un service STT"
  });
});

function videoStub(req, res) {
  if (!req.file) return res.status(400).json({ error: "Fichier vidéo requis" });
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", "attachment; filename=video-language-changer-result.mp4");
  return res.send(req.file.buffer.slice(0, Math.min(req.file.buffer.length, 1024 * 64)));
}

app.post("/api/translate-video", upload.single("video"), videoStub);
app.post("/api/dub-video", upload.single("video"), videoStub);
app.post("/api/create-subtitles", upload.single("video"), videoStub);

/* ───────────── Santé détaillée ───────────── */

app.get("/api/health", (req, res) => {
  const network = detectNetwork(req);
  res.json({
    ok: true,
    network,
    mainnetKey: Boolean(PI_API_KEY_MAINNET),
    testnetKey: Boolean(PI_API_KEY_TESTNET),
    allowDevFallback: ALLOW_DEV_FALLBACK,
    payments: store.payments.size,
    refunds: store.refunds.size,
    publicDir: PUBLIC_DIR,
    uptime: process.uptime()
  });
});

/* ───────────── Route racine + SPA fallback ───────────── */

app.get("/", (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  return res.status(404).send("index.html manquant dans /public");
});

app.get("*", (req, res, next) => {
  if (
    req.path.startsWith("/api/") ||
    req.path === "/ping" ||
    req.path === "/validation-key.txt"
  ) {
    return next();
  }
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  return res.status(404).send("index.html manquant dans /public");
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled", err);
  res.status(500).json({ error: err.message || "Erreur serveur" });
});

app.listen(PORT, () => {
  console.log(`Video Language Changer backend : http://localhost:${PORT}`);
  console.log(`  Public dir     : ${PUBLIC_DIR}`);
  console.log(`  Default network: ${DEFAULT_NETWORK}`);
  console.log(`  Mainnet key    : ${PI_API_KEY_MAINNET ? "OK" : "MANQUANTE"}`);
  console.log(`  Testnet key    : ${PI_API_KEY_TESTNET ? "OK" : "MANQUANTE"}`);
  console.log(`  Dev fallback   : ${ALLOW_DEV_FALLBACK}`);
  console.log(`  Keep-Alive     : GET /ping`);
  console.log(`  Validation     : GET /validation-key.txt`);
});
