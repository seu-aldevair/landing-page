import { getStore } from "@netlify/blobs";

const store = getStore("media");

function extractKey(requestUrl) {
  const url = new URL(requestUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const index = parts.indexOf("media");
  if (index === -1) return null;
  const raw = parts.slice(index + 1).join("/");
  if (!raw) return null;
  return decodeURIComponent(raw);
}

export default async (req) => {
  const key = extractKey(req.url);
  if (!key) {
    return new Response("Missing key", { status: 400 });
  }

  const result = await store.getWithMetadata(key, { type: "arrayBuffer" });
  if (!result) {
    return new Response("Not found", { status: 404 });
  }

  const contentType = result.metadata?.contentType || "application/octet-stream";
  return new Response(result.data, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=31536000"
    }
  });
};
