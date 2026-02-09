import { neon } from "@netlify/neon";
import { getStore } from "@netlify/blobs";
import Busboy from "busboy";
import { Readable } from "stream";

const sql = neon();
const MAX_FILE_SIZE = 40 * 1024 * 1024;
const DEFAULT_WHATS_MESSAGE = "Ola, me interessei no imovel da landing e quero mais informacoes.";

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function getMediaStore() {
  return getStore("media");
}

function extractId(requestUrl) {
  const url = new URL(requestUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const index = parts.indexOf("items");
  if (index === -1) return null;
  return parts[index + 1] || null;
}

function sanitizeFilename(name) {
  const safe = (name || "file").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return safe || "file";
}

function withMediaUrls(media) {
  return (media || []).map((item) => {
    if (item.url) return item;
    if (!item.key) return item;
    const encoded = encodeURIComponent(item.key);
    return {
      ...item,
      url: `/.netlify/functions/media/${encoded}`
    };
  });
}

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS items (
      id text PRIMARY KEY,
      title text NOT NULL,
      description text NOT NULL,
      whatsapp_message text NOT NULL,
      media jsonb NOT NULL,
      created_at timestamptz DEFAULT now()
    );
  `;
}

async function seedIfEmpty() {
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM items`;
  if (count > 0) return;

  const seed = [
    {
      title: "Casa com area gourmet",
      desc: "Ambientes integrados, patio amplo e acabamento premium.",
      media: [{ type: "image", url: "imovel1.jpg" }]
    },
    {
      title: "Apartamento com varanda",
      desc: "Vista aberta, condominio completo e otima localizacao.",
      media: [{ type: "image", url: "imovel2.jpg" }]
    },
    {
      title: "Sobrado em condominio",
      desc: "Seguranca 24h e lazer para toda a familia.",
      media: [{ type: "image", url: "imovel3.jpg" }]
    },
    {
      title: "Casa terrea moderna",
      desc: "Projeto contemporaneo com garagem coberta.",
      media: [{ type: "image", url: "imovel4.jpg" }]
    }
  ];

  for (const item of seed) {
    const id = crypto.randomUUID();
    await sql`
      INSERT INTO items (id, title, description, whatsapp_message, media)
      VALUES (${id}, ${item.title}, ${item.desc}, ${DEFAULT_WHATS_MESSAGE}, ${JSON.stringify(item.media)}::jsonb)
    `;
  }
}

async function parseMultipart(req) {
  const contentType = req.headers.get("content-type") || "";
  const buffer = Buffer.from(await req.arrayBuffer());
  const busboy = Busboy({
    headers: { "content-type": contentType },
    limits: { fileSize: MAX_FILE_SIZE }
  });

  const fields = {};
  const files = [];
  let tooLarge = false;

  return new Promise((resolve, reject) => {
    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("file", (fieldname, file, infoOrFilename, encoding, mimeType) => {
      const info = typeof infoOrFilename === "object"
        ? infoOrFilename
        : { filename: infoOrFilename, mimeType };

      const chunks = [];
      file.on("limit", () => {
        tooLarge = true;
        file.resume();
      });
      file.on("data", (data) => chunks.push(data));
      file.on("end", () => {
        files.push({
          fieldname,
          filename: info.filename || "file",
          contentType: info.mimeType || mimeType || "application/octet-stream",
          buffer: Buffer.concat(chunks)
        });
      });
    });

    busboy.on("error", reject);
    busboy.on("finish", () => {
      if (tooLarge) {
        reject(new Error("FILE_TOO_LARGE"));
        return;
      }
      resolve({ fields, files });
    });

    Readable.from(buffer).pipe(busboy);
  });
}

async function storeFiles(store, files, itemId) {
  const media = [];
  for (const file of files) {
    const safeName = sanitizeFilename(file.filename);
    const key = `${itemId}/${Date.now()}-${crypto.randomUUID()}-${safeName}`;
    await store.set(key, file.buffer, {
      metadata: { contentType: file.contentType }
    });
    media.push({
      type: file.contentType.startsWith("video/") ? "video" : "image",
      key,
      contentType: file.contentType
    });
  }
  return media;
}

function normalizeText(value) {
  return (value || "").toString().trim();
}

export default async (req) => {
  try {
    const store = getMediaStore();
    await ensureSchema();
    await seedIfEmpty();

    const id = extractId(req.url);
    const method = req.method.toUpperCase();

    if (method === "GET") {
      if (id) {
        const rows = await sql`
          SELECT id, title, description AS desc, whatsapp_message AS "whatsappMessage", media
          FROM items
          WHERE id = ${id}
        `;
        if (rows.length === 0) return jsonResponse(404, { error: "Not found" });
        const item = rows[0];
        item.media = withMediaUrls(item.media);
        return jsonResponse(200, item);
      }

      const rows = await sql`
        SELECT id, title, description AS desc, whatsapp_message AS "whatsappMessage", media
        FROM items
        ORDER BY created_at DESC
      `;
      rows.forEach((item) => {
        item.media = withMediaUrls(item.media);
      });
      return jsonResponse(200, rows);
    }

    if (method === "POST") {
      let fields = {};
      let files = [];

      if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
        try {
          ({ fields, files } = await parseMultipart(req));
        } catch (error) {
          if (error.message === "FILE_TOO_LARGE") {
            return jsonResponse(413, { error: "Arquivo acima de 40 MB." });
          }
          throw error;
        }
      } else {
        fields = await req.json();
      }

      const title = normalizeText(fields.title);
      const desc = normalizeText(fields.desc);
      const whatsappMessage = normalizeText(fields.whatsappMessage) || DEFAULT_WHATS_MESSAGE;

      if (!title || !desc) {
        return jsonResponse(400, { error: "Missing required fields." });
      }

      let media = [];
      const newId = crypto.randomUUID();

      if (files.length > 0) {
        media = await storeFiles(store, files, newId);
      } else if (Array.isArray(fields.media)) {
        media = fields.media;
      }

      if (media.length === 0) {
        return jsonResponse(400, { error: "Missing media files." });
      }

      await sql`
        INSERT INTO items (id, title, description, whatsapp_message, media)
        VALUES (${newId}, ${title}, ${desc}, ${whatsappMessage}, ${JSON.stringify(media)}::jsonb)
      `;

      return jsonResponse(201, {
        id: newId,
        title,
        desc,
        whatsappMessage,
        media: withMediaUrls(media)
      });
    }

    if (method === "PUT") {
      if (!id) return jsonResponse(400, { error: "Missing id." });

      let fields = {};
      let files = [];
      if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
        try {
          ({ fields, files } = await parseMultipart(req));
        } catch (error) {
          if (error.message === "FILE_TOO_LARGE") {
            return jsonResponse(413, { error: "Arquivo acima de 40 MB." });
          }
          throw error;
        }
      } else {
        fields = await req.json();
      }

      const existing = await sql`
        SELECT id, title, description AS desc, whatsapp_message AS "whatsappMessage", media
        FROM items
        WHERE id = ${id}
      `;
      if (existing.length === 0) return jsonResponse(404, { error: "Not found" });

      const current = existing[0];
      const nextTitle = normalizeText(fields.title) || current.title;
      const nextDesc = normalizeText(fields.desc) || current.desc;
      const nextMessage = normalizeText(fields.whatsappMessage) || current.whatsappMessage || DEFAULT_WHATS_MESSAGE;
      let nextMedia = current.media;

      if (files.length > 0) {
        nextMedia = await storeFiles(store, files, id);
      } else if (Array.isArray(fields.media) && fields.media.length > 0) {
        nextMedia = fields.media;
      }

      await sql`
        UPDATE items
        SET title = ${nextTitle},
            description = ${nextDesc},
            whatsapp_message = ${nextMessage},
            media = ${JSON.stringify(nextMedia)}::jsonb
        WHERE id = ${id}
      `;

      return jsonResponse(200, {
        id,
        title: nextTitle,
        desc: nextDesc,
        whatsappMessage: nextMessage,
        media: withMediaUrls(nextMedia)
      });
    }

    if (method === "DELETE") {
      if (!id) return jsonResponse(400, { error: "Missing id." });
      const existing = await sql`
        SELECT media FROM items WHERE id = ${id}
      `;
      if (existing.length > 0) {
        const media = existing[0].media || [];
        for (const item of media) {
          if (item.key) {
            await store.delete(item.key);
          }
        }
      }
      await sql`DELETE FROM items WHERE id = ${id}`;
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(405, { error: "Method not allowed." });
  } catch (error) {
    console.error("items function error", error);
    const detail = process.env.NETLIFY_DEV === "true" ? String(error) : undefined;
    return jsonResponse(500, { error: "Server error.", detail });
  }
};
