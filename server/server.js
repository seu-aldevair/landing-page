import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const DEFAULT_WHATS_MESSAGE = "Ola, me interessei no imovel da landing e quero mais informacoes.";
const uploadsDir = path.join(__dirname, "uploads");
const dataFile = path.join(uploadsDir, "items.json");
const siteRoot = path.join(__dirname, "..");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

if (!fs.existsSync(dataFile)) {
  fs.writeFileSync(dataFile, "[]", "utf8");
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "-");
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e6);
    cb(null, unique + "-" + safeName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024
  }
});

app.use(express.json());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");

  const reqHeaders = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Headers", reqHeaders || "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(siteRoot));

function readItems() {
  try {
    const raw = fs.readFileSync(dataFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeItems(items) {
  fs.writeFileSync(dataFile, JSON.stringify(items, null, 2), "utf8");
}

function normalizeItem(item) {
  if (!Array.isArray(item.media) || item.media.length === 0) {
    if (item.url) {
      item.media = [
        {
          type: item.type || "image",
          url: item.url,
          filename: item.filename
        }
      ];
    } else {
      item.media = [];
    }
  }
  if (!item.whatsappMessage || typeof item.whatsappMessage !== "string") {
    item.whatsappMessage = DEFAULT_WHATS_MESSAGE;
  }
  return item;
}

function toItemResponse(item) {
  const normalized = normalizeItem({ ...item });
  return {
    id: normalized.id,
    title: normalized.title,
    desc: normalized.desc,
    whatsappMessage: normalized.whatsappMessage,
    media: normalized.media.map((media) => ({
      type: media.type,
      url: media.url
    })),
    createdAt: normalized.createdAt
  };
}

app.get("/api/items", (req, res) => {
  const items = readItems().map((item) => normalizeItem(item));
  res.json(items.map(toItemResponse));
});

app.post("/api/items", upload.array("files"), (req, res) => {
  const items = readItems();
  const title = (req.body.title || "Novo imovel").trim();
  const desc = (req.body.desc || "Mais detalhes no WhatsApp.").trim();
  const whatsappMessage = (req.body.whatsappMessage || DEFAULT_WHATS_MESSAGE).trim();
  const files = req.files || [];

  if (files.length === 0) {
    res.status(400).json({ error: "No files" });
    return;
  }

  const media = files.map((file) => {
    const isVideo = file.mimetype.startsWith("video/");
    return {
      type: isVideo ? "video" : "image",
      url: "/uploads/" + file.filename,
      filename: file.filename
    };
  });

  const newItem = {
    id: "item-" + Date.now() + "-" + Math.round(Math.random() * 1e6),
    title,
    desc,
    whatsappMessage,
    media,
    type: media[0]?.type || "image",
    url: media[0]?.url || "",
    createdAt: new Date().toISOString()
  };

  const updated = items.concat(newItem);
  writeItems(updated);
  res.json(toItemResponse(newItem));
});

app.put("/api/items/:id", upload.array("files"), (req, res) => {
  const items = readItems();
  const targetId = req.params.id;
  const item = items.find((entry) => entry.id === targetId);

  if (!item) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  normalizeItem(item);

  const title = (req.body.title || item.title).trim();
  const desc = (req.body.desc || item.desc).trim();
  const whatsappMessage = (req.body.whatsappMessage || item.whatsappMessage || DEFAULT_WHATS_MESSAGE).trim();
  item.title = title;
  item.desc = desc;
  item.whatsappMessage = whatsappMessage;

  const files = req.files || [];
  if (files.length > 0) {
    item.media.forEach((media) => {
      if (!media.filename) return;
      const oldPath = path.join(uploadsDir, media.filename);
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    });

    item.media = files.map((file) => {
      const isVideo = file.mimetype.startsWith("video/");
      return {
        type: isVideo ? "video" : "image",
        url: "/uploads/" + file.filename,
        filename: file.filename
      };
    });

    item.type = item.media[0]?.type || "image";
    item.url = item.media[0]?.url || "";
  }

  writeItems(items);
  res.json(toItemResponse(item));
});

app.delete("/api/items/:id", (req, res) => {
  const items = readItems();
  const targetId = req.params.id;
  const index = items.findIndex((entry) => entry.id === targetId);

  if (index === -1) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const [removed] = items.splice(index, 1);
  if (removed) {
    normalizeItem(removed);
    removed.media.forEach((media) => {
      if (!media.filename) return;
      const filePath = path.join(uploadsDir, media.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
  }

  writeItems(items);
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error("Upload error:", err.message);
    res.status(400).json({ error: err.message });
    return;
  }
  if (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Upload error" });
    return;
  }
  next();
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
