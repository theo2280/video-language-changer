require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.resolve(__dirname, "public");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

/* ───────────── Route Validation Key TESTNET ───────────── */
app.get("/validation-key.txt", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send("2e13a98c5e0b7462e8d0d306accab3ed3f0c3d3b0568b023d69ae68c9e8fb8b2d8f59dc5e7336e3c101769c94ecd652a44a769f179f9a856a9f8731e9dcb0f8a");
});

app.get("/ping", (req, res) => res.status(200).send("OK"));
app.use(express.static(PUBLIC_DIR));

app.get("*", (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  return res.status(404).send("index.html non trouve");
});

app.listen(PORT, () => console.log(`Serveur prêt pour Testnet sur le port ${PORT}`));
