import { neon } from "@netlify/neon";

export default async () => {
  const sql = neon(); // Uses NETLIFY_DATABASE_URL automatically.
  const rows = await sql`SELECT 'hello from neon' AS msg`;

  return new Response(JSON.stringify(rows), {
    headers: { "content-type": "application/json" },
  });
};
