import { createClient } from "@supabase/supabase-js";
import Busboy from "busboy";
import { Readable } from "stream";

const DEFAULT_WHATS_MESSAGE = "Ola, me interessei no imovel da landing e quero mais informacoes.";
const MAX_FILE_SIZE = 40 * 1024 * 1024;

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
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

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing Supabase environment variables.");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function getBucket() {
  return process.env.SUPABASE_BUCKET || "media";
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

async function storeFiles(supabase, bucket, files, itemId) {
  const media = [];
  for (const file of files) {
    const safeName = sanitizeFilename(file.filename);
    const path = `${itemId}/${Date.now()}-${crypto.randomUUID()}-${safeName}`;
    const blob = new Blob([file.buffer], { type: file.contentType });
    const { error } = await supabase.storage.from(bucket).upload(path, blob, {
      contentType: file.contentType,
      upsert: false
    });
    if (error) {
      throw new Error(error.message || "Upload failed");
    }
    media.push({
      type: file.contentType.startsWith("video/") ? "video" : "image",
      path,
      contentType: file.contentType
    });
  }
  return media;
}

async function removeStoredMedia(supabase, bucket, media) {
  const paths = (media || [])
    .map((item) => item.path)
    .filter(Boolean);
  if (paths.length === 0) return;
  await supabase.storage.from(bucket).remove(paths);
}

async function withPublicUrls(supabase, bucket, media) {
  const result = [];
  for (const item of media || []) {
    if (item.url) {
      result.push(item);
      continue;
    }
    if (!item.path) {
      result.push(item);
      continue;
    }
    const { data } = supabase.storage.from(bucket).getPublicUrl(item.path);
    result.push({ ...item, url: data.publicUrl });
  }
  return result;
}

function normalizeText(value) {
  return (value || "").toString().trim();
}

async function ensureSeed(supabase) {
  const { count, error } = await supabase
    .from("items")
    .select("id", { count: "exact", head: true });
  if (error) throw error;
  if (count && count > 0) return;

  const seed = [
    {
      title: "Casa com area gourmet",
      description: "Ambientes integrados, patio amplo e acabamento premium.",
      whatsapp_message: DEFAULT_WHATS_MESSAGE,
      media: [{ type: "image", url: "imovel1.jpg" }]
    },
    {
      title: "Apartamento com varanda",
      description: "Vista aberta, condominio completo e otima localizacao.",
      whatsapp_message: DEFAULT_WHATS_MESSAGE,
      media: [{ type: "image", url: "imovel2.jpg" }]
    },
    {
      title: "Sobrado em condominio",
      description: "Seguranca 24h e lazer para toda a familia.",
      whatsapp_message: DEFAULT_WHATS_MESSAGE,
      media: [{ type: "image", url: "imovel3.jpg" }]
    },
    {
      title: "Casa terrea moderna",
      description: "Projeto contemporaneo com garagem coberta.",
      whatsapp_message: DEFAULT_WHATS_MESSAGE,
      media: [{ type: "image", url: "imovel4.jpg" }]
    }
  ];

  const { error: insertError } = await supabase.from("items").insert(seed);
  if (insertError) throw insertError;
}

export default async (req) => {
  try {
    const supabase = getSupabase();
    const bucket = getBucket();
    await ensureSeed(supabase);

    const id = extractId(req.url);
    const method = req.method.toUpperCase();

    if (method === "GET") {
      if (id) {
        const { data, error } = await supabase
          .from("items")
          .select("id, title, description, whatsapp_message, media, created_at")
          .eq("id", id)
          .maybeSingle();
        if (error) throw error;
        if (!data) return jsonResponse(404, { error: "Not found" });

        const media = await withPublicUrls(supabase, bucket, data.media);
        return jsonResponse(200, {
          id: data.id,
          title: data.title,
          desc: data.description,
          whatsappMessage: data.whatsapp_message,
          media
        });
      }

      const { data, error } = await supabase
        .from("items")
        .select("id, title, description, whatsapp_message, media, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;

      const items = [];
      for (const item of data || []) {
        const media = await withPublicUrls(supabase, bucket, item.media);
        items.push({
          id: item.id,
          title: item.title,
          desc: item.description,
          whatsappMessage: item.whatsapp_message,
          media
        });
      }
      return jsonResponse(200, items);
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
      if (files.length > 0) {
        media = await storeFiles(supabase, bucket, files, crypto.randomUUID());
      } else if (Array.isArray(fields.media)) {
        media = fields.media;
      }
      if (media.length === 0) {
        return jsonResponse(400, { error: "Missing media files." });
      }

      const { data, error } = await supabase.from("items").insert({
        title,
        description: desc,
        whatsapp_message: whatsappMessage,
        media
      }).select().single();
      if (error) throw error;

      const signedMedia = await withPublicUrls(supabase, bucket, data.media);
      return jsonResponse(201, {
        id: data.id,
        title: data.title,
        desc: data.description,
        whatsappMessage: data.whatsapp_message,
        media: signedMedia
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

      const { data: current, error: currentError } = await supabase
        .from("items")
        .select("id, title, description, whatsapp_message, media")
        .eq("id", id)
        .maybeSingle();
      if (currentError) throw currentError;
      if (!current) return jsonResponse(404, { error: "Not found" });

      const nextTitle = normalizeText(fields.title) || current.title;
      const nextDesc = normalizeText(fields.desc) || current.description;
      const nextMessage = normalizeText(fields.whatsappMessage) || current.whatsapp_message || DEFAULT_WHATS_MESSAGE;
      let nextMedia = current.media || [];

      if (files.length > 0) {
        await removeStoredMedia(supabase, bucket, nextMedia);
        nextMedia = await storeFiles(supabase, bucket, files, current.id);
      } else if (Array.isArray(fields.media) && fields.media.length > 0) {
        nextMedia = fields.media;
      }

      const { data, error } = await supabase.from("items").update({
        title: nextTitle,
        description: nextDesc,
        whatsapp_message: nextMessage,
        media: nextMedia
      }).eq("id", id).select().single();
      if (error) throw error;

      const signedMedia = await withPublicUrls(supabase, bucket, data.media);
      return jsonResponse(200, {
        id: data.id,
        title: data.title,
        desc: data.description,
        whatsappMessage: data.whatsapp_message,
        media: signedMedia
      });
    }

    if (method === "DELETE") {
      if (!id) return jsonResponse(400, { error: "Missing id." });
      const { data, error } = await supabase
        .from("items")
        .select("media")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      if (data?.media) {
        await removeStoredMedia(supabase, bucket, data.media);
      }
      const { error: deleteError } = await supabase.from("items").delete().eq("id", id);
      if (deleteError) throw deleteError;
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(405, { error: "Method not allowed." });
  } catch (error) {
    console.error("items function error", error);
    return jsonResponse(500, { error: "Server error." });
  }
};
