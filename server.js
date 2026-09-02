/**
 * Video Language Changer — Backend Node.js (Pi Network)
 * Version : 100% local (Whisper + Piper + FFmpeg), MongoDB Atlas, sans AWS.
 * Déploiement : Render (Docker)
 *
 * Endpoints :
 *  GET  /ping
 *  POST /api/authenticate
 *  POST /api/pi/me
 *  POST /api/pi/approve
 *  POST /api/pi/complete
 *  POST /api/pi/refund
 *  POST /api/detect-language
 *  POST /api/translate-video
 *  POST /api/dub-video
 *  POST /api/create-subtitles
 *  GET  /api/job/:id
 *  GET  /api/download/:filename
 *  POST /api/me/subscription
 *  GET  /api/health
 *
 * Variables d'environnement : voir .env.example
 */

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const { promisify } = require("util");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { MongoClient, ObjectId } = require("mongodb");
const { execFile, spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.resolve(__dirname, "public");
const TMP_DIR = path.resolve(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const PI_API_BASE = process.env.PI_API_BASE || "https://api.minepi.com/v2";
const PI_API_KEY_MAINNET = process.env.PI_API_KEY_MAINNET || "";
const PI_API_KEY_TESTNET = process.env.PI_API_KEY_TESTNET || "";
const ALLOW_DEV_FALLBACK = process.env.ALLOW_DEV_FALLBACK === "true";

const MONGODB_URI = process.env.MONGODB_URI || "";

const TTS_ENGINE = process.env.TTS_ENGINE || "piper";
const PIPER_BIN = process.env.PIPER_BIN || "/app/bin/piper";
const PIPER_MODEL = process.env.PIPER_MODEL || "/app/models/voice.onnx";
const PIPER_MODEL_CONFIG = process.env.PIPER_MODEL_CONFIG || "/app/models/voice.onnx.json";

const WHISPER_MODEL = process.env.WHISPER_MODEL || "base";

const APP_URL = process.env.APP_URL || "http://localhost:" + PORT;

/* ───────────── MongoDB ───────────── */

let db;
let usersCol;
let paymentsCol;
let refundsCol;
let subscriptionsCol;
let jobsCol;

async function initMongo() {
  if (!MONGODB_URI) {
    console.warn(
      "MONGODB_URI non défini : utilisation de la mémoire locale (NON RECOMMANDÉ EN PROD)."
    );
    return;
  }

  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });

  await client.connect();
  db = client.db();
  usersCol = db.collection("users");
  paymentsCol = db.collection("payments");
  refundsCol = db.collection("refunds");
  subscriptionsCol = db.collection("subscriptions");
  jobsCol = db.collection("jobs");

  console.log("MongoDB connecté");
}

/* ───────────── Mémoire locale (fallback) ───────────── */

const store = {
  users: new Map(),
  payments: new Map(),
  refunds: new Map(),
  subscriptions: new Map(),
  jobs: new Map(),
};

/* ───────────── Express setup ───────────── */

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 Mo pour Render gratuit
});

/* ───────────── Helpers Pi ───────────── */

function apiKeyFor(network) {
  return network === "testnet" ? PI_API_KEY_TESTNET : PI_API_KEY_MAINNET;
}

async function piFetch(
  pathname,
  { method = "GET", network = "mainnet", accessToken, body } = {}
) {
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

  const response = await fetch(`${PI_API_BASE}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const err = new Error(
      data?.error_message || data?.message || `Pi API ${response.status}`
    );
    err.status = response.status;
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

async function saveSubscription(uid, plan, network, paymentId) {
  const days = planDays(plan);

  const sub = {
    uid,
    plan,
    network,
    paymentId,
    activatedAt: Date.now(),
    expiresAt: Date.now() + days * 86400000,
  };

  if (subscriptionsCol) {
    await subscriptionsCol.updateOne(
      { uid },
      { $set: sub },
      { upsert: true }
    );
  } else {
    store.subscriptions.set(uid, sub);
  }

  return sub;
}

/* ───────────── Helpers Whisper (transcription) ───────────── */

const execFileAsync = promisify(execFile);

async function transcribeWithWhisper(audioPath) {
  const outDir = TMP_DIR;
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const jsonPath = path.join(outDir, baseName + ".json");

  await execFileAsync("whisper", [
    audioPath,
    "--model",
    WHISPER_MODEL,
    "--output_format",
    "json",
    "--output_dir",
    outDir,
    "--verbose",
    "False",
  ]);

  if (!fs.existsSync(jsonPath)) {
    throw new Error("Whisper n'a pas généré de JSON de transcription");
  }

  const jsonRaw = fs.readFileSync(jsonPath, "utf8");
  const json = JSON.parse(jsonRaw);

  const segments = (json.segments || []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));

  const fullText = segments.map((s) => s.text).join(" ");

  return { fullText, segments };
}

/* ───────────── Helpers TTS (Piper / espeak) ───────────── */

async function synthesizeWithPiper(text, outWavPath) {
  const args = ["-m", PIPER_MODEL, "-f", outWavPath];

  const child = spawn(PIPER_BIN, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdin.write(Buffer.from(text, "utf8"));
  child.stdin.end();

  await new Promise((resolve, reject) => {
    child.stderr.on("data", (data) => {
      console.error("Piper stderr:", data.toString());
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Piper exited with code ${code}`));
      }
    });
  });
}

async function synthesizeWithEspeak(text, outWavPath) {
  // BONNE PRATIQUE : Remplacement des sauts de ligne (\n, \r) et espaces multiples par un espace simple
  const safeText = String(text).replace(/\\"/g, '\\"').replace(/\s+/g, ' ').trim();
  await execFileAsync("espeak", ["-w", outWavPath, safeText]);
}

async function synthesizeSpeech(text, outWavPath) {
  if (TTS_ENGINE === "piper") {
    await synthesizeWithPiper(text, outWavPath);
  } else {
    await synthesizeWithEspeak(text, outWavPath);
  }
}

/* ───────────── Helpers Sous-titres (SRT) ───────────── */

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds) * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;

  return (
    String(h).padStart(2, "0") +
    ":" +
    String(m).padStart(2, "0") +
    ":" +
    String(s).padStart(2, "0") +
    "," +
    String(ms).padStart(3, "0")
  );
}

function buildSrt(segments) {
  let srt = "";
  segments.forEach((seg, i) => {
    // CORRECTION : utilisation de \n (au lieu de sauts de ligne physiques)
    srt += String(i + 1) + "\n";
    srt += formatSrtTime(seg.start) + " --> " + formatSrtTime(seg.end) + "\n";
    srt += seg.tgtText + "\n\n";
  });
  return srt;
}

/* ───────────── Helpers Traduction (locale, sans API) ───────────── */

async function translateText(text, sourceLang = "fr", targetLang = "en") {
  return "[" + targetLang + "] " + text;
}

async function translateSegments(segments, sourceLang, targetLang) {
  const out = [];
  for (const seg of segments) {
    const tgtText = await translateText(seg.text, sourceLang, targetLang);
    out.push({
      start: seg.start,
      end: seg.end,
      srcText: seg.text,
      tgtText: tgtText,
    });
  }
  return out;
}

/* ───────────── Helpers FFmpeg ───────────── */

async function extractAudioFromVideo(videoPath, outWavPath) {
  await execFileAsync("ffmpeg", [
    "-i",
    videoPath,
    "-vn",
    "-acodec",
    "pcm_s16le",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-y",
    outWavPath,
  ]);
}

async function muxVideoWithSubtitles(videoPath, srtPath, outMp4Path) {
  const escapedSrt = srtPath.replace(/:/g, "\\:");
  await execFileAsync("ffmpeg", [
    "-i",
    videoPath,
    "-vf",
    "subtitles=" + escapedSrt,
    "-c:a",
    "copy",
    "-y",
    outMp4Path,
  ]);
}

async function muxVideoWithNewAudio(videoPath, audioPath, outMp4Path) {
  await execFileAsync("ffmpeg", [
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-shortest",
    "-y",
    outMp4Path,
  ]);
}

async function concatAudioFiles(audioFiles, outMp3Path) {
  const listFile = path.join(TMP_DIR, crypto.randomUUID() + ".txt");
  const lines = audioFiles.map(function (f) {
    return "file '" + f.replace(/'/g, "'\\''") + "'";
  });
  // CORRECTION : utilisation de \n
  fs.writeFileSync(listFile, lines.join("\n"), "utf8");

  await execFileAsync("ffmpeg", [
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    "-y",
    outMp3Path,
  ]);

  fs.unlinkSync(listFile);
}

/* ───────────── Auth / Pi ───────────── */

app.post("/api/authenticate", async function (req, res) {
  const user = (req.body || {}).user;

  if (user && user.uid) {
    console.log("UID RÉCUPÉRÉ :", user.uid, "USERNAME :", user.username);

    const doc = {
      uid: user.uid,
      username: user.username,
      lastSeen: Date.now(),
    };

    if (usersCol) {
      await usersCol.updateOne(
        { uid: user.uid },
        { $set: doc },
        { upsert: true }
      );
    } else {
      store.users.set(user.uid, doc);
    }

    return res.status(200).json({
      success: true,
      uid: user.uid,
    });
  }

  return res.status(400).json({
    error: "UID non trouvé",
  });
});

app.post("/api/pi/me", async function (req, res) {
  try {
    const body = req.body || {};
    const accessToken = body.accessToken;
    const network = body.network || "mainnet";

    if (!accessToken) {
      return res.status(400).json({ error: "accessToken requis" });
    }

    let user;
    try {
      user = await piFetch("/me", { accessToken: accessToken, network: network });
    } catch (e) {
      if (ALLOW_DEV_FALLBACK && e.code === "NO_API_KEY") {
        user = { uid: "dev-uid", username: "dev_pioneer" };
      } else {
        throw e;
      }
    }

    const doc = Object.assign({}, user, { network: network, lastSeen: Date.now() });
    if (usersCol) {
      await usersCol.updateOne(
        { uid: user.uid || user.username },
        { $set: doc },
        { upsert: true }
      );
    } else {
      store.users.set(user.uid || user.username, doc);
    }

    return res.json({ ok: true, user: user });
  } catch (err) {
    console.error("POST /api/pi/me", err.message, err.data || "");
    return res.status(err.status || 500).json({
      error: "Vérification utilisateur échouée",
      detail: err.message,
    });
  }
});

app.post("/api/pi/approve", async function (req, res) {
  try {
    const body = req.body || {};
    const paymentId = body.paymentId;
    const network = body.network || "mainnet";
    const orderId = body.orderId;
    const plan = body.plan;
    const amount = body.amount;
    const accessToken = body.accessToken;

    if (!paymentId) {
      return res.status(400).json({ error: "paymentId requis" });
    }

    let existing = null;
    if (paymentsCol) {
      existing = await paymentsCol.findOne({ paymentId: paymentId });
    } else {
      existing = store.payments.get(paymentId) || null;
    }

    if (
      existing &&
      (existing.status === "approved" || existing.status === "completed")
    ) {
      return res.json({ ok: true, payment: existing, already: true });
    }

    let approved;
    try {
      approved = await piFetch("/payments/" + paymentId + "/approve", {
        method: "POST",
        network: network,
      });
    } catch (e) {
      if (ALLOW_DEV_FALLBACK && e.code === "NO_API_KEY") {
        approved = { identifier: paymentId, status: "approved_dev" };
      } else {
        throw e;
      }
    }

    const doc = {
      paymentId: paymentId,
      network: network,
      orderId: orderId,
      plan: plan,
      amount: amount,
      status: "approved",
      accessToken: accessToken || null,
      updatedAt: Date.now(),
    };

    if (paymentsCol) {
      await paymentsCol.updateOne(
        { paymentId: paymentId },
        { $set: doc },
        { upsert: true }
      );
    } else {
      store.payments.set(paymentId, doc);
    }

    return res.json({ ok: true, payment: approved });
  } catch (err) {
    console.error("POST /api/pi/approve", err.message, err.data || "");
    return res.status(err.status || 500).json({
      error: "Approbation refusée",
      detail: err.message,
    });
  }
});

app.post("/api/pi/complete", async function (req, res) {
  try {
    const body = req.body || {};
    const paymentId = body.paymentId;
    const txid = body.txid;
    const plan = body.plan;
    const network = body.network || "mainnet";
    const orderId = body.orderId;
    const accessToken = body.accessToken;

    if (!paymentId) {
      return res.status(400).json({ error: "paymentId requis" });
    }

    let existing = null;
    if (paymentsCol) {
      existing = await paymentsCol.findOne({ paymentId: paymentId });
    } else {
      existing = store.payments.get(paymentId) || null;
    }

    if (existing && existing.status === "completed") {
      let subscription = null;
      if (existing.uid && subscriptionsCol) {
        subscription = await subscriptionsCol.findOne({ uid: existing.uid });
      } else if (existing.uid) {
        subscription = store.subscriptions.get(existing.uid) || null;
      }
      return res.json({
        ok: true,
        payment: existing,
        subscription: subscription,
        already: true,
      });
    }

    let completed;
    try {
      completed = await piFetch("/payments/" + paymentId + "/complete", {
        method: "POST",
        network: network,
        body: { txid: txid },
      });
    } catch (e) {
      if (ALLOW_DEV_FALLBACK && e.code === "NO_API_KEY") {
        completed = {
          identifier: paymentId,
          transaction: { txid: txid },
          status: "completed_dev",
        };
      } else {
        throw e;
      }
    }

    let prev = {};
    if (paymentsCol) {
      prev = (await paymentsCol.findOne({ paymentId: paymentId })) || {};
    } else {
      prev = store.payments.get(paymentId) || {};
    }

    let uid = null;
    if (accessToken) {
      try {
        const me = await piFetch("/me", { accessToken: accessToken, network: network });
        uid = me.uid || me.username;
      } catch (_) {}
    }
    if (!uid && completed && completed.user_uid) uid = completed.user_uid;
    if (!uid && prev.uid) uid = prev.uid;

    const record = Object.assign({}, prev, {
      paymentId: paymentId,
      txid: txid,
      plan: plan || prev.plan,
      network: network,
      orderId: orderId || prev.orderId,
      status: "completed",
      accessToken: accessToken || prev.accessToken || null,
      uid: uid || prev.uid || null,
      updatedAt: Date.now(),
    });

    if (paymentsCol) {
      await paymentsCol.updateOne(
        { paymentId: paymentId },
        { $set: record },
        { upsert: true }
      );
    } else {
      store.payments.set(paymentId, record);
    }

    if (uid && record.plan) {
      await saveSubscription(uid, record.plan, network, paymentId);
    }

    let subscription = null;
    if (uid) {
      if (subscriptionsCol) {
        subscription = await subscriptionsCol.findOne({ uid: uid });
      } else {
        subscription = store.subscriptions.get(uid) || null;
      }
    }

    return res.json({ ok: true, payment: completed, subscription: subscription });
  } catch (err) {
    console.error("POST /api/pi/complete", err.message, err.data || "");
    return res.status(err.status || 500).json({
      error: "Confirmation refusée",
      detail: err.message,
    });
  }
});

app.post("/api/pi/refund", async function (req, res) {
  try {
    const body = req.body || {};
    const accessToken = body.accessToken;
    const network = body.network || "mainnet";
    const username = body.username;
    const uid = body.uid;
    const paymentId = body.paymentId;
    const txid = body.txid;
    const amount = body.amount;
    const plan = body.plan;
    const reason = body.reason || "litige";

    if (!accessToken && !uid) {
      return res.status(400).json({ error: "accessToken ou uid requis" });
    }

    let userUid = uid;
    let userName = username;

    if (accessToken) {
      try {
        const me = await piFetch("/me", { accessToken: accessToken, network: network });
        userUid = me.uid || me.username;
        userName = me.username || username;
      } catch (e) {
        if (!(ALLOW_DEV_FALLBACK && e.code === "NO_API_KEY")) throw e;
        userUid = userUid || "dev-uid";
        userName = userName || "dev_pioneer";
      }
    }

    if (paymentId) {
      let existingRefund = null;
      if (refundsCol) {
        existingRefund = await refundsCol.findOne({
          originalPaymentId: paymentId,
        });
      } else {
        existingRefund = store.refunds.get(paymentId) || null;
      }

      if (existingRefund) {
        return res.status(409).json({
          error: "Remboursement déjà effectué pour ce paiement",
          refund: existingRefund,
        });
      }
    }

    let original = null;
    if (paymentsCol) {
      original = await paymentsCol.findOne({ paymentId: paymentId });
    } else {
      original = store.payments.get(paymentId) || null;
    }

    const refundAmount = Number(amount || (original && original.amount) || 0);
    if (!refundAmount || refundAmount <= 0) {
      return res.status(400).json({ error: "Montant de remboursement invalide" });
    }

    const allowed = [
      "echec_traduction",
      "litige",
      "echec_doublage",
      "echec_sous_titres",
    ];
    if (!allowed.includes(reason) && reason !== "litige") {
      console.warn("Raison de remboursement non standard:", reason);
    }

    const memo =
      "Remboursement VLC · " +
      reason +
      " · " +
      (plan || "abonnement") +
      " · " +
      network;

    let a2u;
    try {
      a2u = await piFetch("/payments", {
        method: "POST",
        network: network,
        body: {
          payment: {
            amount: refundAmount,
            memo: memo,
            metadata: {
              type: "refund",
              reason: reason,
              originalPaymentId: paymentId || null,
              originalTxid: txid || null,
              product: "Video Language Changer",
            },
            uid: userUid,
          },
        },
      });
    } catch (e) {
      if (ALLOW_DEV_FALLBACK && e.code === "NO_API_KEY") {
        a2u = {
          identifier: "dev-refund-" + Date.now(),
          amount: refundAmount,
          status: "pending_dev",
          transaction: { txid: "dev-txid-" + Date.now() },
        };
      } else {
        throw e;
      }
    }

    const refundRecord = {
      refundPaymentId: a2u.identifier || a2u.paymentId,
      originalPaymentId: paymentId || null,
      amount: refundAmount,
      reason: reason,
      network: network,
      uid: userUid,
      username: userName,
      txid: (a2u.transaction && a2u.transaction.txid) || null,
      status: a2u.status || "created",
      createdAt: new Date(),
    };

    if (refundsCol) {
      await refundsCol.insertOne(refundRecord);
      if (paymentId) {
        await paymentsCol.updateOne(
          { paymentId: paymentId },
          { $set: { status: "refunded", refundedAt: new Date() } }
        );
      }
      if (userUid && subscriptionsCol) {
        await subscriptionsCol.deleteOne({ uid: userUid });
      }
    } else {
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
    }

    return res.json({
      ok: true,
      refund: refundRecord,
      txid: refundRecord.txid,
      message: "Remboursement A2U initié",
    });
  } catch (err) {
    console.error("POST /api/pi/refund", err.message, err.data || "");
    return res.status(err.status || 500).json({
      error: "Remboursement refusé",
      detail: err.message,
      pi: err.data || null,
    });
  }
});

/* ───────────── Jobs vidéo ───────────── */

app.post("/api/detect-language", upload.single("video"), async function (req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Fichier vidéo requis" });
    }

    const jobId = crypto.randomUUID();
    const jobDoc = {
      _id: new ObjectId(),
      jobId: jobId,
      type: "detect-language",
      status: "processing",
      createdAt: new Date(),
      input: {
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      },
    };

    if (jobsCol) await jobsCol.insertOne(jobDoc);
    else store.jobs.set(jobId, jobDoc);

    const videoExt = path.extname(req.file.originalname) || ".mp4";
    const videoTmp = path.join(TMP_DIR, jobId + videoExt);
    const audioTmp = path.join(TMP_DIR, jobId + ".wav");

    fs.writeFileSync(videoTmp, req.file.buffer);
    await extractAudioFromVideo(videoTmp, audioTmp);

    const resultWhisper = await transcribeWithWhisper(audioTmp);
    const fullText = resultWhisper.fullText;
    const segments = resultWhisper.segments;

    const detectedLang = "fr";

    const result = {
      language: detectedLang,
      confidence: "high",
      transcriptionSample: fullText.slice(0, 300),
    };

    const updateDoc = {
      status: "completed",
      completedAt: new Date(),
      result: result,
      transcription: { fullText: fullText, segments: segments },
    };

    if (jobsCol) {
      await jobsCol.updateOne({ jobId: jobId }, { $set: updateDoc });
    } else {
      const j = store.jobs.get(jobId);
      store.jobs.set(jobId, Object.assign({}, j, updateDoc));
    }

    try {
      fs.unlinkSync(videoTmp);
      fs.unlinkSync(audioTmp);
    } catch (e) {}

    return res.json(Object.assign({ jobId: jobId }, result));
  } catch (err) {
    console.error("/api/detect-language error", err);
    return res
      .status(500)
      .json({ error: err.message || "Erreur détection langue" });
  }
});

app.post("/api/create-subtitles", upload.single("video"), async function (req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Fichier vidéo requis" });
    }

    const body = req.body || {};
    const targetLang = body.targetLang || "en";
    const sourceLang = body.sourceLang || "fr";

    const jobId = crypto.randomUUID();
    const jobDoc = {
      _id: new ObjectId(),
      jobId: jobId,
      type: "create-subtitles",
      status: "processing",
      createdAt: new Date(),
      input: {
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
        targetLang: targetLang,
        sourceLang: sourceLang,
      },
    };

    if (jobsCol) await jobsCol.insertOne(jobDoc);
    else store.jobs.set(jobId, jobDoc);

    const videoExt = path.extname(req.file.originalname) || ".mp4";
    const videoTmp = path.join(TMP_DIR, jobId + videoExt);
    const audioTmp = path.join(TMP_DIR, jobId + ".wav");

    fs.writeFileSync(videoTmp, req.file.buffer);
    await extractAudioFromVideo(videoTmp, audioTmp);

    const whisperResult = await transcribeWithWhisper(audioTmp);
    const translated = await translateSegments(
      whisperResult.segments,
      sourceLang,
      targetLang
    );
    const srtContent = buildSrt(translated);

    const srtTmp = path.join(TMP_DIR, jobId + ".srt");
    fs.writeFileSync(srtTmp, srtContent, "utf8");

    const outMp4 = path.join(TMP_DIR, jobId + "-subtitled.mp4");
    await muxVideoWithSubtitles(videoTmp, srtTmp, outMp4);

    const outFilename = jobId + "-subtitled.mp4";
    const outPath = path.join(TMP_DIR, outFilename);
    const outBuffer = fs.readFileSync(outMp4);
    fs.writeFileSync(outPath, outBuffer);

    const updateDoc = {
      status: "completed",
      completedAt: new Date(),
      result: {
        filename: outFilename,
        downloadUrl: APP_URL + "/api/download/" + outFilename,
        srtAvailable: true,
      },
      segments: translated,
    };

    if (jobsCol) {
      await jobsCol.updateOne({ jobId: jobId }, { $set: updateDoc });
    } else {
      const j = store.jobs.get(jobId);
      store.jobs.set(jobId, Object.assign({}, j, updateDoc));
    }

    try {
      fs.unlinkSync(videoTmp);
      fs.unlinkSync(audioTmp);
      fs.unlinkSync(srtTmp);
    } catch (e) {}

    return res.json({
      jobId: jobId,
      downloadUrl: APP_URL + "/api/download/" + outFilename,
      filename: outFilename,
    });
  } catch (err) {
    console.error("/api/create-subtitles error", err);
    return res
      .status(500)
      .json({ error: err.message || "Erreur sous-titres" });
  }
});

app.post("/api/dub-video", upload.single("video"), async function (req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Fichier vidéo requis" });
    }

    const body = req.body || {};
    const targetLang = body.targetLang || "en";
    const sourceLang = body.sourceLang || "fr";

    const jobId = crypto.randomUUID();
    const jobDoc = {
      _id: new ObjectId(),
      jobId: jobId,
      type: "dub-video",
      status: "processing",
      createdAt: new Date(),
      input: {
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
        targetLang: targetLang,
        sourceLang: sourceLang,
      },
    };

    if (jobsCol) await jobsCol.insertOne(jobDoc);
    else store.jobs.set(jobId, jobDoc);

    const videoExt = path.extname(req.file.originalname) || ".mp4";
    const videoTmp = path.join(TMP_DIR, jobId + videoExt);
    const audioTmp = path.join(TMP_DIR, jobId + ".wav");

    fs.writeFileSync(videoTmp, req.file.buffer);
    await extractAudioFromVideo(videoTmp, audioTmp);

    const whisperResult = await transcribeWithWhisper(audioTmp);
    const translated = await translateSegments(
      whisperResult.segments,
      sourceLang,
      targetLang
    );

    const audioFiles = [];
    for (let i = 0; i < translated.length; i++) {
      const seg = translated[i];
      const segWav = path.join(
        TMP_DIR,
        jobId + "-seg-" + Math.random().toString(36).slice(2) + ".wav"
      );
      await synthesizeSpeech(seg.tgtText, segWav);
      audioFiles.push(segWav);
    }

    const dubAudioMp3 = path.join(TMP_DIR, jobId + "-dub.mp3");
    await concatAudioFiles(audioFiles, dubAudioMp3);

    const outMp4 = path.join(TMP_DIR, jobId + "-dubbed.mp4");
    await muxVideoWithNewAudio(videoTmp, dubAudioMp3, outMp4);

    const outFilename = jobId + "-dubbed.mp4";
    const outPath = path.join(TMP_DIR, outFilename);
    const outBuffer = fs.readFileSync(outMp4);
    fs.writeFileSync(outPath, outBuffer);

    const updateDoc = {
      status: "completed",
      completedAt: new Date(),
      result: {
        filename: outFilename,
        downloadUrl: APP_URL + "/api/download/" + outFilename,
        dubbed: true,
      },
      segments: translated,
    };

    if (jobsCol) {
      await jobsCol.updateOne({ jobId: jobId }, { $set: updateDoc });
    } else {
      const j = store.jobs.get(jobId);
      store.jobs.set(jobId, Object.assign({}, j, updateDoc));
    }

    try {
      fs.unlinkSync(videoTmp);
      fs.unlinkSync(audioTmp);
      fs.unlinkSync(dubAudioMp3);
      audioFiles.forEach(function (f) {
        try {
          fs.unlinkSync(f);
        } catch (e) {}
      });
    } catch (e) {}

    return res.json({
      jobId: jobId,
      downloadUrl: APP_URL + "/api/download/" + outFilename,
      filename: outFilename,
    });
  } catch (err) {
    console.error("/api/dub-video error", err);
    return res.status(500).json({ error: err.message || "Erreur doublage" });
  }
});

app.post("/api/translate-video", upload.single("video"), async function (req, res) {
  if (!req.file) {
    return res.status(400).json({ error: "Fichier vidéo requis" });
  }

  const body = req.body || {};
  const targetLang = body.targetLang || "en";
  const sourceLang = body.sourceLang || "fr";

  const jobId = crypto.randomUUID();
  const jobDoc = {
    _id: new ObjectId(),
    jobId: jobId,
    type: "translate-video",
    status: "processing",
    createdAt: new Date(),
    input: {
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      targetLang: targetLang,
      sourceLang: sourceLang,
    },
  };

  if (jobsCol) await jobsCol.insertOne(jobDoc);
  else store.jobs.set(jobId, jobDoc);

  try {
    const videoExt = path.extname(req.file.originalname) || ".mp4";
    const videoTmp = path.join(TMP_DIR, jobId + videoExt);
    const audioTmp = path.join(TMP_DIR, jobId + ".wav");

    fs.writeFileSync(videoTmp, req.file.buffer);
    await extractAudioFromVideo(videoTmp, audioTmp);

    const whisperResult = await transcribeWithWhisper(audioTmp);
    const translated = await translateSegments(
      whisperResult.segments,
      sourceLang,
      targetLang
    );

    const srtContent = buildSrt(translated);
    const srtTmp = path.join(TMP_DIR, jobId + ".srt");
    fs.writeFileSync(srtTmp, srtContent, "utf8");

    const audioFiles = [];
    for (let i = 0; i < translated.length; i++) {
      const seg = translated[i];
      const segWav = path.join(
        TMP_DIR,
        jobId + "-seg-" + Math.random().toString(36).slice(2) + ".wav"
      );
      await synthesizeSpeech(seg.tgtText, segWav);
      audioFiles.push(segWav);
    }

    const dubAudioMp3 = path.join(TMP_DIR, jobId + "-dub.mp3");
    await concatAudioFiles(audioFiles, dubAudioMp3);

    const outMp4 = path.join(TMP_DIR, jobId + "-translated.mp4");
    const withSubs = path.join(TMP_DIR, jobId + "-withsubs.mp4");

    await muxVideoWithSubtitles(videoTmp, srtTmp, withSubs);
    await muxVideoWithNewAudio(withSubs, dubAudioMp3, outMp4);

    const outFilename = jobId + "-translated.mp4";
    const outPath = path.join(TMP_DIR, outFilename);
    const outBuffer = fs.readFileSync(outMp4);
    fs.writeFileSync(outPath, outBuffer);

    const updateDoc = {
      status: "completed",
      completedAt: new Date(),
      result: {
        filename: outFilename,
        downloadUrl: APP_URL + "/api/download/" + outFilename,
        translated: true,
        dubbed: true,
        subtitled: true,
      },
      segments: translated,
    };

    if (jobsCol) {
      await jobsCol.updateOne({ jobId: jobId }, { $set: updateDoc });
    } else {
      const j = store.jobs.get(jobId);
      store.jobs.set(jobId, Object.assign({}, j, updateDoc));
    }

    try {
      fs.unlinkSync(videoTmp);
      fs.unlinkSync(audioTmp);
      fs.unlinkSync(srtTmp);
      fs.unlinkSync(dubAudioMp3);
      fs.unlinkSync(withSubs);
      audioFiles.forEach(function (f) {
        try {
          fs.unlinkSync(f);
        } catch (e) {}
      });
    } catch (e) {}

    return res.json({
      jobId: jobId,
      downloadUrl: APP_URL + "/api/download/" + outFilename,
      filename: outFilename,
    });
  } catch (err) {
    console.error("/api/translate-video error", err);
    return res
      .status(500)
      .json({ error: err.message || "Erreur traduction vidéo" });
  }
});

app.get("/api/job/:id", async function (req, res) {
  const id = req.params.id;
  let job;

  if (jobsCol) {
    job = await jobsCol.findOne({ jobId: id });
  } else {
    job = store.jobs.get(id) || null;
  }

  if (!job) {
    return res.status(404).json({ error: "Job non trouvé" });
  }

  return res.json(job);
});

app.get("/api/download/:filename", function (req, res) {
  const safeName = path.basename(req.params.filename);

  if (safeName !== req.params.filename) {
    return res.status(400).send("Nom de fichier invalide");
  }

  const filePath = path.join(TMP_DIR, safeName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Fichier introuvable");
  }

  return res.download(filePath);
});

/* ───────────── Keep-alive ───────────── */

app.get("/ping", function (_req, res) {
  res.send("pong");
});

/* ───────────── Subscription utilisateur ───────────── */

app.post("/api/me/subscription", async function (req, res) {
  try {
    const body = req.body || {};
    const accessToken = body.accessToken;
    const network = body.network || "mainnet";
    const uid = body.uid;

    if (!accessToken && !uid) {
      return res.status(400).json({ error: "accessToken ou uid requis" });
    }

    let userUid = uid;

    if (accessToken) {
      try {
        const me = await piFetch("/me", { accessToken: accessToken, network: network });
        userUid = me.uid || me.username;
      } catch (e) {
        if (!(ALLOW_DEV_FALLBACK && e.code === "NO_API_KEY")) {
          return res.status(401).json({ error: "Utilisateur non authentifié" });
        }
        userUid = userUid || "dev-uid";
      }
    }

    if (!userUid) {
      return res.status(400).json({ error: "uid invalide" });
    }

    let subscription = null;

    if (subscriptionsCol) {
      subscription = await subscriptionsCol.findOne({ uid: userUid });
    } else {
      subscription = store.subscriptions.get(userUid) || null;
    }

    if (!subscription) {
      return res.json({
        active: false,
        plan: null,
        expiresAt: null,
      });
    }

    const now = Date.now();
    const isActive =
      subscription.expiresAt && subscription.expiresAt > now;

    return res.json({
      active: isActive,
      plan: subscription.plan || null,
      expiresAt: subscription.expiresAt || null,
      activatedAt: subscription.activatedAt || null,
    });
  } catch (err) {
    console.error("POST /api/me/subscription", err);
    return res.status(500).json({
      error: "Erreur lors de la vérification de l'abonnement",
      detail: err.message,
    });
  }
});

/* ───────────── Santé ───────────── */

app.get("/api/health", async function (_req, res) {
  let paymentsCount = 0;
  let refundsCount = 0;

  if (paymentsCol) paymentsCount = await paymentsCol.countDocuments();
  else paymentsCount = store.payments.size;

  if (refundsCol) refundsCount = await refundsCol.countDocuments();
  else refundsCount = store.refunds.size;

  res.json({
    ok: true,
    mainnetKey: Boolean(PI_API_KEY_MAINNET),
    testnetKey: Boolean(PI_API_KEY_TESTNET),
    allowDevFallback: ALLOW_DEV_FALLBACK,
    payments: paymentsCount,
    refunds: refundsCount,
    publicDir: PUBLIC_DIR,
    mongoConnected: Boolean(db),
    ttsEngine: TTS_ENGINE,
    whisperModel: WHISPER_MODEL,
  });
});

/* ───────────── Routes statiques ───────────── */

app.get("/", function (req, res) {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  return res.status(404).send("index.html manquant dans /public");
});

app.get("*", function (req, res, next) {
  if (req.path.startsWith("/api/")) return next();

  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  return res.status(404).send("index.html manquant dans /public");
});

app.use(function (err, _req, res, _next) {
  console.error("Unhandled", err);
  res.status(500).json({ error: err.message || "Erreur serveur" });
});

/* ───────────── Init ───────────── */

(async function () {
  await initMongo();
  app.listen(PORT, function () {
    console.log("Video Language Changer backend : http://localhost:" + PORT);
    console.log("  Public dir  : " + PUBLIC_DIR);
    console.log("  Mainnet key : " + (PI_API_KEY_MAINNET ? "OK" : "MANQUANTE"));
    console.log("  Testnet key : " + (PI_API_KEY_TESTNET ? "OK" : "MANQUANTE"));
    console.log("  Dev fallback: " + ALLOW_DEV_FALLBACK);
    console.log("  MongoDB     : " + (MONGODB_URI ? "OK" : "NON CONFIGURÉ"));
    console.log("  TTS Engine  : " + TTS_ENGINE);
    console.log("  Whisper     : " + WHISPER_MODEL);
    console.log("  APP_URL     : " + APP_URL);
  });
})();
