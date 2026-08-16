interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  API_TOKEN: string;
  ALLOWED_ORIGINS: string;
}

type PromptInput = {
  id?: string;
  title?: string;
  category?: string;
  content?: string;
  tags?: string[];
  favorite?: boolean;
  pinned?: boolean;
  archived?: boolean;
  version?: number;
  operationId?: string;
  createdAt?: string;
  updatedAt?: string;
};

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((v) => v.trim());
  return {
    "access-control-allow-origin": allowed.includes(origin) ? origin : allowed[0] || "",
    "access-control-allow-headers": "authorization, content-type, if-match",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function authorized(request: Request, env: Env) {
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${env.API_TOKEN}`;
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((v) => v.trim()).filter(Boolean))].slice(0, 8);
}

function rowToPrompt(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    content: row.content,
    tags: JSON.parse(String(row.tags_json || "[]")),
    favorite: Boolean(row.favorite),
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
    attachmentCount: Number(row.attachment_count || 0),
  };
}

async function getPrompt(env: Env, id: string) {
  return env.DB.prepare(`SELECT p.*,
    (SELECT COUNT(*) FROM attachments a WHERE a.prompt_id=p.id AND a.deleted_at IS NULL) AS attachment_count
    FROM prompts p WHERE p.id = ?`).bind(id).first<Record<string, unknown>>();
}

async function upsertPrompt(env: Env, body: PromptInput, force = false) {
  const now = new Date().toISOString();
  const id = body.id || crypto.randomUUID();
  const operationId = body.operationId || crypto.randomUUID();
  const duplicate = await env.DB.prepare("SELECT operation_id FROM operations WHERE operation_id = ?")
    .bind(operationId).first();
  if (duplicate) {
    const existing = await getPrompt(env, id);
    return { prompt: existing ? rowToPrompt(existing) : null, duplicate: true };
  }

  const existing = await getPrompt(env, id);
  if (existing && !force && Number(body.version) !== Number(existing.version)) {
    return { conflict: rowToPrompt(existing) };
  }

  const title = String(body.title ?? existing?.title ?? "").trim().slice(0, 200);
  const content = String(body.content ?? existing?.content ?? "");
  const category = String(body.category ?? existing?.category ?? "Geral").trim().slice(0, 80) || "Geral";
  if (!title || !content.trim()) return { invalid: "Título e conteúdo são obrigatórios." };
  const tags = cleanTags(body.tags ?? JSON.parse(String(existing?.tags_json || "[]")));
  const version = existing ? Number(existing.version) + 1 : 1;
  const createdAt = String(existing?.created_at || body.createdAt || now);

  const statements = [
    env.DB.prepare(`INSERT INTO prompts
      (id,title,category,content,tags_json,favorite,pinned,archived,version,created_at,updated_at,deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, category=excluded.category,
      content=excluded.content, tags_json=excluded.tags_json, favorite=excluded.favorite,
      pinned=excluded.pinned, archived=excluded.archived, version=excluded.version,
      updated_at=excluded.updated_at, deleted_at=NULL`)
      .bind(id, title, category, content, JSON.stringify(tags), body.favorite ? 1 : 0,
        body.pinned ? 1 : 0, body.archived ? 1 : 0, version, createdAt, now),
    env.DB.prepare("INSERT INTO operations(operation_id,prompt_id,processed_at) VALUES(?,?,?)")
      .bind(operationId, id, now),
  ];
  await env.DB.batch(statements);
  return { prompt: rowToPrompt((await getPrompt(env, id))!) };
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const headers = cors(request, env);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (path === "/api/health") return json({ ok: true, service: "prompt-master-api" }, 200, headers);
  if (!authorized(request, env)) return json({ error: "Não autorizado." }, 401, headers);

  if (path === "/api/prompts" && request.method === "GET") {
    const since = url.searchParams.get("since");
    const base = `SELECT p.*,
      (SELECT COUNT(*) FROM attachments a WHERE a.prompt_id=p.id AND a.deleted_at IS NULL) AS attachment_count
      FROM prompts p`;
    const query = since
      ? env.DB.prepare(`${base} WHERE p.updated_at > ? OR p.deleted_at > ? ORDER BY p.updated_at DESC`).bind(since, since)
      : env.DB.prepare(`${base} ORDER BY p.pinned DESC, p.updated_at DESC`);
    const result = await query.all<Record<string, unknown>>();
    return json({ prompts: result.results.map(rowToPrompt), serverTime: new Date().toISOString() }, 200, headers);
  }

  if (path === "/api/prompts" && request.method === "POST") {
    const result = await upsertPrompt(env, await request.json<PromptInput>());
    if (result.invalid) return json({ error: result.invalid }, 422, headers);
    if (result.conflict) return json({ error: "conflict", server: result.conflict }, 409, headers);
    return json(result, 201, headers);
  }

  if (path === "/api/sync" && request.method === "POST") {
    const payload = await request.json<{ operations?: PromptInput[] }>();
    const results = [];
    for (const operation of (payload.operations || []).slice(0, 100)) {
      const result = await upsertPrompt(env, operation);
      results.push({ operationId: operation.operationId, ...result });
    }
    return json({ results, serverTime: new Date().toISOString() }, 200, headers);
  }

  if (path === "/api/export" && request.method === "GET") {
    const prompts = await env.DB.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM attachments a WHERE a.prompt_id=p.id AND a.deleted_at IS NULL) AS attachment_count
      FROM prompts p WHERE p.deleted_at IS NULL ORDER BY p.category,p.title`)
      .all<Record<string, unknown>>();
    return json({ schemaVersion: 1, exportedAt: new Date().toISOString(), prompts: prompts.results.map(rowToPrompt) }, 200, {
      ...headers,
      "content-disposition": `attachment; filename="prompt-master-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  }

  const promptMatch = path.match(/^\/api\/prompts\/([^/]+)$/);
  if (promptMatch && request.method === "PATCH") {
    const body = await request.json<PromptInput>();
    body.id = decodeURIComponent(promptMatch[1]);
    const result = await upsertPrompt(env, body, url.searchParams.get("force") === "1");
    if (result.invalid) return json({ error: result.invalid }, 422, headers);
    if (result.conflict) return json({ error: "conflict", server: result.conflict }, 409, headers);
    return json(result, 200, headers);
  }

  if (promptMatch && request.method === "DELETE") {
    const id = decodeURIComponent(promptMatch[1]);
    const body = await request.json<{ operationId?: string; version?: number }>().catch(() => ({}));
    const operationId = body.operationId || crypto.randomUUID();
    const duplicate = await env.DB.prepare("SELECT operation_id FROM operations WHERE operation_id=?").bind(operationId).first();
    if (duplicate) return json({ ok: true, id, duplicate: true }, 200, headers);
    const existing = await getPrompt(env, id);
    if (!existing) return json({ ok: true }, 200, headers);
    if (url.searchParams.get("force") !== "1" && Number(body.version) !== Number(existing.version))
      return json({ error: "conflict", server: rowToPrompt(existing) }, 409, headers);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE prompts SET deleted_at=?, updated_at=?, version=version+1 WHERE id=?").bind(now, now, id),
      env.DB.prepare("INSERT OR IGNORE INTO operations(operation_id,prompt_id,processed_at) VALUES(?,?,?)")
        .bind(operationId, id, now),
    ]);
    return json({ ok: true, id, deletedAt: now }, 200, headers);
  }

  const attachmentsMatch = path.match(/^\/api\/prompts\/([^/]+)\/attachments$/);
  if (attachmentsMatch && request.method === "GET") {
    const promptId = decodeURIComponent(attachmentsMatch[1]);
    const result = await env.DB.prepare(`SELECT id,prompt_id,name,content_type,size,created_at
      FROM attachments WHERE prompt_id=? AND deleted_at IS NULL ORDER BY created_at`)
      .bind(promptId).all<Record<string, unknown>>();
    return json({ attachments: result.results.map(item => ({
      id: item.id, promptId: item.prompt_id, name: item.name, contentType: item.content_type,
      size: item.size, createdAt: item.created_at,
    })) }, 200, headers);
  }

  if (attachmentsMatch && request.method === "POST") {
    const promptId = decodeURIComponent(attachmentsMatch[1]);
    if (!(await getPrompt(env, promptId))) return json({ error: "Prompt não encontrado." }, 404, headers);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "Arquivo ausente." }, 422, headers);
    if (file.size > 5 * 1024 * 1024) return json({ error: "O limite por arquivo é 5 MB." }, 413, headers);
    const requestedId = String(form.get("attachmentId") || "");
    const id = /^[0-9a-f-]{36}$/i.test(requestedId) ? requestedId : crypto.randomUUID();
    const duplicate = await env.DB.prepare("SELECT id,prompt_id,name,size FROM attachments WHERE id=?").bind(id).first<Record<string, unknown>>();
    if (duplicate) return json({ attachment: { id: duplicate.id, promptId: duplicate.prompt_id, name: duplicate.name, size: duplicate.size }, duplicate: true }, 200, headers);
    const key = `${promptId}/${id}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    await env.ATTACHMENTS.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
    await env.DB.prepare(`INSERT INTO attachments(id,prompt_id,name,content_type,size,r2_key,created_at)
      VALUES(?,?,?,?,?,?,?)`).bind(id, promptId, file.name, file.type || "application/octet-stream", file.size, key, new Date().toISOString()).run();
    await env.DB.prepare("UPDATE prompts SET updated_at=? WHERE id=?").bind(new Date().toISOString(), promptId).run();
    return json({ attachment: { id, promptId, name: file.name, size: file.size } }, 201, headers);
  }

  const attachmentMatch = path.match(/^\/api\/attachments\/([^/]+)$/);
  if (attachmentMatch && request.method === "GET") {
    const item = await env.DB.prepare("SELECT * FROM attachments WHERE id=? AND deleted_at IS NULL")
      .bind(decodeURIComponent(attachmentMatch[1])).first<Record<string, unknown>>();
    if (!item) return json({ error: "Anexo não encontrado." }, 404, headers);
    const object = await env.ATTACHMENTS.get(String(item.r2_key));
    if (!object) return json({ error: "Arquivo não encontrado." }, 404, headers);
    return new Response(object.body, { headers: { ...headers, "content-type": String(item.content_type),
      "content-disposition": `attachment; filename="${String(item.name).replace(/"/g, "")}"` } });
  }

  return json({ error: "Rota não encontrada." }, 404, headers);
}

export default {
  fetch(request: Request, env: Env) {
    return handleApi(request, env).catch((error) => {
      console.error(error);
      return json({ error: "Erro interno." }, 500, cors(request, env));
    });
  },
} satisfies ExportedHandler<Env>;
