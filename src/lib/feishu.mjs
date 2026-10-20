import { panelLabels } from "./desktop.mjs";
import { BLOCKED_HINT } from "./format.mjs";
import { sleep } from "./paths.mjs";

// Feishu and Lark are one platform on two sets of hosts. Which one a user is on
// is the tenant's brand, reported by the registration that created the app.
const HOSTS = {
  feishu: { open: "https://open.feishu.cn", accounts: "https://accounts.feishu.cn" },
  lark: { open: "https://open.larksuite.com", accounts: "https://accounts.larksuite.com" },
};

export function feishuBrand(raw) {
  return String(raw ?? "").trim().toLowerCase() === "lark" ? "lark" : "feishu";
}

export function feishuHosts(brand) {
  return HOSTS[feishuBrand(brand)];
}

export function feishuCreds(env = process.env) {
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    return undefined;
  }
  return { appId, appSecret, brand: feishuBrand(env.FEISHU_DOMAIN) };
}

// The one Feishu user allowed to drive panes: whoever scanned the pairing code.
export function feishuOpenId(env = process.env) {
  return env.FEISHU_OPEN_ID?.trim() || undefined;
}

// One door for every Feishu HTTP call, so the timeout and the tolerant body
// parse are decided in a single place, as `telegramApi` does for Telegram.
export async function feishuFetch(url, options = {}) {
  const { method = "POST", body, form, headers = {}, timeoutMs = 15_000, fetchImpl = fetch } = options;
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (form) {
    init.headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    init.headers["content-type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(body);
  }
  const response = await fetchImpl(url, init);
  const text = await response.text().catch(() => "");
  return { ok: response.ok, status: response.status, text, json: parseBody(text) };
}

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// A tenant token lasts two hours. The hook is one process per event and fetches
// its own; the poller lives for days and reuses one until it is close to expiry.
const tokens = new Map();
const TOKEN_MARGIN_MS = 5 * 60_000;

async function tenantToken(creds, { fetchImpl, fresh = false } = {}) {
  const key = `${creds.brand}:${creds.appId}`;
  const cached = tokens.get(key);
  if (!fresh && cached && cached.exp - Date.now() > TOKEN_MARGIN_MS) {
    return cached.token;
  }
  const { json, status } = await feishuFetch(
    `${feishuHosts(creds.brand).open}/open-apis/auth/v3/tenant_access_token/internal`,
    { body: { app_id: creds.appId, app_secret: creds.appSecret }, fetchImpl },
  );
  if (json?.code !== 0 || !json.tenant_access_token) {
    throw new Error(`feishu token failed: ${json?.code ?? status} ${json?.msg || ""}`.trim());
  }
  tokens.set(key, { token: json.tenant_access_token, exp: Date.now() + Number(json.expire || 7200) * 1000 });
  return json.tenant_access_token;
}

// What Feishu answers when a cached token was revoked or rotated early: worth
// one retry with a fresh token, never a loop.
const STALE_TOKEN_CODES = new Set([99991661, 99991663, 99991668]);

export async function feishuApi(creds, method, path, body, { fetchImpl } = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = await tenantToken(creds, { fetchImpl, fresh: attempt > 0 });
    const result = await feishuFetch(`${feishuHosts(creds.brand).open}/open-apis${path}`, {
      method,
      body,
      headers: { authorization: `Bearer ${token}` },
      fetchImpl,
    });
    const code = result.json?.code;
    if (code === 0) {
      return result.json;
    }
    if (attempt === 0 && STALE_TOKEN_CODES.has(code)) {
      continue;
    }
    const detail = result.json?.msg || result.text.slice(0, 200);
    throw new Error(`feishu ${method} ${path.split("?")[0]} failed: ${code ?? result.status} ${detail}`.trim());
  }
}

function plainDiv(content) {
  return { tag: "div", text: { tag: "plain_text", content } };
}

// In Feishu, typing an answer to a particular ping means quoting it.
export const FEISHU_HINT = "tap a button, or quote this card to type an answer";

// A blocked ping with choices: the same text Telegram sends, then one button per
// choice. Plain text throughout, like every other message this plugin sends.
// `note` replaces the buttons once one was pressed, so the card says what
// happened and cannot be pressed a second time; the hint about pressing goes
// with them.
export function feishuCard({ text, options = [], note }) {
  const full = String(text ?? "");
  const body = full.endsWith(BLOCKED_HINT) ? full.slice(0, -BLOCKED_HINT.length).trimEnd() : full;
  const pressable = options.length > 0 && !note;
  const elements = [plainDiv(pressable ? `${body}\n\n${FEISHU_HINT}` : body)];
  panelLabels(pressable ? options : []).forEach((label, index) => {
    const option = options[index];
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: label },
      type: "default",
      width: "fill",
      behaviors: [{ type: "callback", value: { send: String(option.send || option.key) } }],
    });
  });
  if (note) {
    elements.push(plainDiv(note));
  }
  return { schema: "2.0", config: { update_multi: true }, body: { elements } };
}

export async function sendFeishu(creds, openId, text, { options = [], fetchImpl } = {}) {
  const message = options.length
    ? { msg_type: "interactive", content: JSON.stringify(feishuCard({ text, options })) }
    : { msg_type: "text", content: JSON.stringify({ text }) };
  const json = await feishuApi(
    creds,
    "POST",
    "/im/v1/messages?receive_id_type=open_id",
    { receive_id: openId, ...message },
    { fetchImpl },
  );
  return json?.data?.message_id;
}

export async function updateFeishuCard(creds, messageId, card, { fetchImpl } = {}) {
  await feishuApi(
    creds,
    "PATCH",
    `/im/v1/messages/${encodeURIComponent(messageId)}`,
    { content: JSON.stringify(card) },
    { fetchImpl },
  );
}

// Where the long connection lives this time. The URL carries the service id
// every ping has to name.
export async function feishuWsEndpoint(creds, { fetchImpl } = {}) {
  const { json, status } = await feishuFetch(`${feishuHosts(creds.brand).open}/callback/ws/endpoint`, {
    body: { AppID: creds.appId, AppSecret: creds.appSecret },
    headers: { locale: "zh" },
    fetchImpl,
  });
  if (json?.code !== 0 || !json?.data?.URL) {
    throw new Error(`feishu ws endpoint failed: ${json?.code ?? status} ${json?.msg || ""}`.trim());
  }
  const url = json.data.URL;
  const pingSec = Number(json.data.ClientConfig?.PingInterval);
  return {
    url,
    serviceId: Number(new URL(url).searchParams.get("service_id") || 0),
    pingMs: pingSec > 0 ? pingSec * 1000 : 120_000,
  };
}

// Scan-to-pair is Feishu's app registration, a device flow: `begin` hands back a
// code and a page to open in the Feishu app, and polling with the code returns
// a newly created app's credentials plus the open_id of whoever scanned. The
// protocol always starts on the Feishu hosts, whatever the user's brand.
const REGISTRATION_PATH = "/oauth/v1/app/registration";

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export async function feishuRegistrationBegin({ fetchImpl } = {}) {
  const { json, status } = await feishuFetch(`${HOSTS.feishu.accounts}${REGISTRATION_PATH}`, {
    form: {
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id tenant_brand",
    },
    timeoutMs: 30_000,
    fetchImpl,
  });
  if (!json || json.error || status >= 400) {
    throw new Error(`feishu registration failed: ${json?.error_description || json?.error || `HTTP ${status}`}`);
  }
  if (!json.device_code) {
    throw new Error("feishu registration failed: no device_code in the response");
  }
  const url =
    json.verification_uri_complete ||
    `${HOSTS.feishu.open}/page/cli?user_code=${encodeURIComponent(json.user_code ?? "")}`;
  return {
    deviceCode: json.device_code,
    url,
    interval: positive(json.interval, 5),
    // The protocol spells it expire_in; older responses said expires_in.
    expiresIn: positive(json.expire_in ?? json.expires_in, 600),
  };
}

// Polls until the scan is approved, refused, or runs out of time. Returns
// { kind: "paired", appId, appSecret, openId, brand } | { kind: "denied" } |
// { kind: "expired" } | { kind: "cancelled" } | { kind: "error", message }.
// A Lark user's tenant shows up in a poll as `user_info.tenant_brand`, and the
// credentials are issued on the Lark hosts, so polling moves there once.
export async function feishuRegistrationWait({
  deviceCode,
  interval = 5,
  expiresAt,
  wanted = () => true,
  fetchImpl,
  wait = sleep,
  now = Date.now,
}) {
  let brand = "feishu";
  let switched = false;
  let delay = interval;
  let immediate = true;
  while (true) {
    if (!immediate) {
      await wait(delay * 1000);
    }
    immediate = false;
    if (!wanted()) {
      return { kind: "cancelled" };
    }
    if (now() >= expiresAt) {
      return { kind: "expired" };
    }
    let json;
    try {
      ({ json } = await feishuFetch(`${HOSTS[brand].accounts}${REGISTRATION_PATH}`, {
        form: { action: "poll", device_code: deviceCode },
        fetchImpl,
      }));
    } catch {
      json = undefined;
    }
    if (!json) {
      delay = Math.min(delay + 1, 60);
      continue;
    }
    const reported = json.user_info?.tenant_brand;
    if (!switched && reported && feishuBrand(reported) !== brand) {
      brand = feishuBrand(reported);
      switched = true;
      immediate = true;
      continue;
    }
    if (!json.error) {
      if (json.client_id && json.client_secret) {
        return {
          kind: "paired",
          appId: json.client_id,
          appSecret: json.client_secret,
          openId: json.user_info?.open_id,
          brand,
        };
      }
      continue;
    }
    switch (json.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        delay = Math.min(delay + 5, 60);
        continue;
      case "access_denied":
        return { kind: "denied" };
      case "expired_token":
      case "invalid_grant":
        return { kind: "expired" };
      default:
        return { kind: "error", message: json.error_description || json.error };
    }
  }
}
