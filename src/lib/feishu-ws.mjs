import { feishuWsEndpoint } from "./feishu.mjs";

// Feishu's long connection: a WebSocket that carries protobuf frames (pbbp2).
// There is no public URL to receive events on, so this is how replies and card
// taps reach a machine behind NAT. The frame has nine fields, all varints or
// length-delimited, so it is decoded here by hand rather than pulling in a
// protobuf runtime.
//
//   Frame  { 1 SeqID uint64, 2 LogID uint64, 3 service int32, 4 method int32,
//            5 headers Header[], 6 payload_encoding, 7 payload_type,
//            8 payload bytes, 9 LogIDNew }
//   Header { 1 key string, 2 value string }
//
// method 0 is control (ping/pong), 1 is data (events). Every data frame is
// answered with the same frame and a JSON payload `{ code, data? }`, where
// `data` is the base64 of the handler's result — for a card tap, the toast and
// the card that replaces the one tapped.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CONTROL = 0;
const DATA = 1;

function varint(value) {
  let rest = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  while (rest > 0x7fn) {
    bytes.push(Number((rest & 0x7fn) | 0x80n));
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return Uint8Array.from(bytes);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function field(number, wire) {
  return varint((number << 3) | wire);
}

function delimited(number, bytes) {
  return [field(number, 2), varint(bytes.length), bytes];
}

export function encodeFrame(frame) {
  const parts = [
    field(1, 0),
    varint(frame.SeqID ?? 0n),
    field(2, 0),
    varint(frame.LogID ?? 0n),
    field(3, 0),
    varint(frame.service ?? 0),
    field(4, 0),
    varint(frame.method ?? 0),
  ];
  for (const header of frame.headers ?? []) {
    const body = concat([
      ...delimited(1, encoder.encode(String(header.key))),
      ...delimited(2, encoder.encode(String(header.value ?? ""))),
    ]);
    parts.push(...delimited(5, body));
  }
  if (frame.payloadEncoding) {
    parts.push(...delimited(6, encoder.encode(frame.payloadEncoding)));
  }
  if (frame.payloadType) {
    parts.push(...delimited(7, encoder.encode(frame.payloadType)));
  }
  if (frame.payload) {
    parts.push(...delimited(8, frame.payload));
  }
  if (frame.LogIDNew) {
    parts.push(...delimited(9, encoder.encode(frame.LogIDNew)));
  }
  return concat(parts);
}

// Calls `visit(number, value)` for each field: a BigInt for a varint, a
// Uint8Array for a length-delimited one. Fixed-width fields are skipped; pbbp2
// has none, but an unknown one must not derail the rest.
function readFields(bytes, visit) {
  let pos = 0;
  const readVarint = () => {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (pos >= bytes.length) {
        throw new Error("truncated frame");
      }
      const byte = bytes[pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) {
        return result;
      }
    }
    throw new Error("varint too long");
  };
  while (pos < bytes.length) {
    const tag = Number(readVarint());
    const wire = tag & 7;
    if (wire === 0) {
      visit(tag >> 3, readVarint());
    } else if (wire === 2) {
      const length = Number(readVarint());
      if (pos + length > bytes.length) {
        throw new Error("truncated frame");
      }
      visit(tag >> 3, bytes.subarray(pos, pos + length));
      pos += length;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
}

function int32(value) {
  return Number(BigInt.asIntN(32, value));
}

export function decodeFrame(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const frame = { SeqID: 0n, LogID: 0n, service: 0, method: 0, headers: [] };
  readFields(bytes, (number, value) => {
    switch (number) {
      case 1:
        frame.SeqID = value;
        break;
      case 2:
        frame.LogID = value;
        break;
      case 3:
        frame.service = int32(value);
        break;
      case 4:
        frame.method = int32(value);
        break;
      case 5: {
        const header = { key: "", value: "" };
        readFields(value, (inner, text) => {
          if (inner === 1) {
            header.key = decoder.decode(text);
          } else if (inner === 2) {
            header.value = decoder.decode(text);
          }
        });
        frame.headers.push(header);
        break;
      }
      case 6:
        frame.payloadEncoding = decoder.decode(value);
        break;
      case 7:
        frame.payloadType = decoder.decode(value);
        break;
      case 8:
        frame.payload = value.slice();
        break;
      case 9:
        frame.LogIDNew = decoder.decode(value);
        break;
      default:
        break;
    }
  });
  return frame;
}

// A large event arrives split over several frames sharing a message_id, each
// with its `seq` out of `sum`. Returns the whole payload once every piece is
// in, undefined before that.
export function mergeFragments(store, headers, payload, now = Date.now()) {
  const sum = Number(headers.sum || 1);
  if (!(sum > 1)) {
    return payload;
  }
  for (const [id, entry] of store) {
    if (now - entry.at > 10_000) {
      store.delete(id);
    }
  }
  const id = headers.message_id;
  const entry = store.get(id) ?? { parts: new Array(sum).fill(undefined), at: now };
  entry.parts[Number(headers.seq || 0)] = payload;
  store.set(id, entry);
  if (entry.parts.some((part) => part === undefined)) {
    return undefined;
  }
  store.delete(id);
  return concat(entry.parts);
}

// A handler result has to ride back in the ack, and Feishu gives a card tap
// three seconds before it shows the user an error. Anything slower is acked
// without a result; the work itself carries on regardless.
const RESPONSE_DEADLINE_MS = 2500;
const CHECK_MS = 10_000;

function withDeadline(value, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([Promise.resolve(value), late]).finally(() => clearTimeout(timer));
}

// One connection, from endpoint lookup to close. Resolves with the reason it
// ended; the caller decides when to dial again. `onEvent(envelope)` returns the
// response for that event (or a promise of it) and must not do slow work
// inline. `stillCurrent()` is checked every few seconds so a re-pair or an
// edited .env drops a connection made with the old credentials.
export async function connectFeishu({
  creds,
  onEvent,
  stillCurrent = () => true,
  WebSocketImpl = globalThis.WebSocket,
  fetchImpl,
  log = console,
  checkMs = CHECK_MS,
}) {
  const endpoint = await feishuWsEndpoint(creds, { fetchImpl });
  return new Promise((resolve) => {
    const ws = new WebSocketImpl(endpoint.url);
    ws.binaryType = "arraybuffer";
    const fragments = new Map();
    let pingMs = endpoint.pingMs;
    let lastFrame = Date.now();
    let lastPing = 0;
    let timer;
    let settled = false;

    const finish = (reason) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(reason);
    };
    const send = (frame) => {
      if (ws.readyState === 1) {
        ws.send(encodeFrame(frame));
      }
    };
    const ping = () => {
      lastPing = Date.now();
      send({
        SeqID: 0n,
        LogID: 0n,
        service: endpoint.serviceId,
        method: CONTROL,
        headers: [{ key: "type", value: "ping" }],
      });
    };

    const respond = async (frame, payload) => {
      const started = Date.now();
      let code = 200;
      let result;
      try {
        result = await withDeadline(onEvent(JSON.parse(decoder.decode(payload))), RESPONSE_DEADLINE_MS);
      } catch (error) {
        code = 500;
        log.error(`feishu · event failed: ${error?.message || error}`);
      }
      const body = { code };
      if (result !== undefined && result !== null) {
        body.data = Buffer.from(JSON.stringify(result)).toString("base64");
      }
      send({
        ...frame,
        headers: [...frame.headers, { key: "biz_rt", value: String(Date.now() - started) }],
        payload: encoder.encode(JSON.stringify(body)),
      });
    };

    const receive = (data) => {
      lastFrame = Date.now();
      let frame;
      try {
        frame = decodeFrame(new Uint8Array(data));
      } catch (error) {
        log.error(`feishu · unreadable frame: ${error.message}`);
        return;
      }
      const headers = Object.fromEntries(frame.headers.map((header) => [header.key, header.value]));
      if (frame.method === CONTROL) {
        if (headers.type === "pong" && frame.payload) {
          try {
            const config = JSON.parse(decoder.decode(frame.payload));
            if (Number(config.PingInterval) > 0) {
              pingMs = Number(config.PingInterval) * 1000;
            }
          } catch {
            /* a pong is still a pong */
          }
        }
        return;
      }
      if (frame.method !== DATA || (headers.type !== "event" && headers.type !== "card")) {
        return;
      }
      const payload = mergeFragments(fragments, headers, frame.payload ?? new Uint8Array());
      if (payload) {
        respond(frame, payload).catch((error) => log.error(`feishu · ack failed: ${error?.message || error}`));
      }
    };

    ws.addEventListener("open", () => {
      log.log("feishu · connected");
      ping();
      timer = setInterval(() => {
        if (!stillCurrent()) {
          finish("credentials changed");
          return;
        }
        // A pong normally lands within a second of each ping, so silence for a
        // whole interval past the last one means a dead link nobody closed.
        if (Date.now() - lastFrame > pingMs + 60_000) {
          finish("no pong");
          return;
        }
        if (Date.now() - lastPing >= pingMs) {
          ping();
        }
      }, checkMs);
    });
    ws.addEventListener("message", (event) => receive(event.data));
    ws.addEventListener("close", (event) => {
      finish(`closed ${event?.code ?? ""}${event?.reason ? ` ${event.reason}` : ""}`.trim());
    });
    ws.addEventListener("error", (event) => {
      finish(`socket error${event?.message ? `: ${event.message}` : ""}`);
    });
  });
}
