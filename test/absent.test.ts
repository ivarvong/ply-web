import assert from "node:assert/strict";
import { test } from "node:test";
import {
  atIndex,
  cacheMatch,
  captureGroup,
  chainGet,
  decodeJson,
  dig,
  endOptionalSpan,
  envBinding,
  fromAbsent,
  fromNullable,
  header,
  isPlatformAbsent,
  jsonField,
  manualInit,
  mapGet,
  otelAttribute,
  otelListField,
  queryParam,
  r2Get,
  recordGet,
  requestHeader,
  requestQuery,
  thrownField,
  writeSpanAttribute,
} from "../src/absent.ts";
import { none, some } from "../src/option.ts";

test("fromAbsent keeps null and fromNullable does not", () => {
  const missing = new Map<string, string>().get("missing");
  assert.equal(isPlatformAbsent(missing), true);
  assert.deepEqual(fromAbsent(missing), none());
  assert.deepEqual(fromNullable(missing), none());
  assert.deepEqual(fromAbsent(null), some(null));
  assert.deepEqual(fromNullable(null), none());
  assert.deepEqual(fromNullable(0), some(0));
  assert.deepEqual(fromNullable(""), some(""));
  assert.deepEqual(fromAbsent("x"), some("x"));
});

test("map and record reads turn a missing key into none", () => {
  const present = new Map([["k", "v"]]);
  assert.deepEqual(mapGet(present, "k"), some("v"));
  assert.deepEqual(mapGet(present, "missing"), none());
  assert.deepEqual(recordGet({ a: "1" }, "a"), some("1"));
  assert.deepEqual(recordGet({ a: "1" }, "b"), none());
  assert.deepEqual(recordGet({ a: null }, "a"), some(null));
  assert.deepEqual(recordGet(null, "a"), none());
  const missingRecord = new Map<string, Record<string, string>>().get("env");
  assert.deepEqual(recordGet(missingRecord, "a"), none());
});

test("chainGet and dig collapse a broken chain", () => {
  assert.deepEqual(dig({ a: { b: 1 } }, ["a", "b"]), some(1));
  assert.deepEqual(dig({ a: null }, ["a", "b"]), none());
  assert.deepEqual(dig(null, ["a"]), none());
  assert.deepEqual(dig({ a: 1 }, []), some({ a: 1 }));
  assert.deepEqual(chainGet({ a: null }, "a"), none());
  assert.deepEqual(chainGet(1, "a"), none());
});

test("atIndex and capture groups treat a hole as none", () => {
  const sparse: string[] = [];
  sparse.length = 1;
  assert.deepEqual(atIndex(sparse, 0), none());
  assert.deepEqual(atIndex(["a"], 0), some("a"));
  assert.deepEqual(atIndex(["a"], -1), none());
  assert.deepEqual(atIndex(["a"], 1.5), none());
  const match = /^(\d+)|([a-z]+)$/.exec("ab");
  assert.deepEqual(captureGroup(match, 1), none());
  assert.deepEqual(captureGroup(match, 2), some("ab"));
  assert.deepEqual(captureGroup(null, 0), none());
});

test("headers, query, and request helpers", () => {
  const headers = new Headers();
  assert.deepEqual(header(headers, "etag"), none());
  headers.set("etag", "abc");
  assert.deepEqual(header(headers, "etag"), some("abc"));
  const params = new URL("https://ply.example/v1/read?path=README").searchParams;
  assert.deepEqual(queryParam(params, "path"), some("README"));
  assert.deepEqual(queryParam(params, "ref"), none());
  const request = new Request("https://ply.example/v1/read?path=README", { headers: { "x-ply-unit": "abc" } });
  assert.deepEqual(requestHeader(request, "x-ply-unit"), some("abc"));
  assert.deepEqual(requestHeader(request, "authorization"), none());
  assert.deepEqual(requestQuery(request, "path"), some("README"));
  assert.deepEqual(requestQuery(request, "ref"), none());
});

test("env bindings treat a missing binding as none and empty text as present", () => {
  const missing = new Map<string, string>().get("FLAGS");
  assert.deepEqual(envBinding(missing), none());
  assert.deepEqual(envBinding(null), none());
  assert.deepEqual(envBinding(""), some(""));
  assert.deepEqual(envBinding("5"), some("5"));
});

test("cache match and R2 get", async () => {
  const miss = {
    async match(_request: RequestInfo | URL): Promise<Response | null> {
      return null;
    },
  };
  assert.deepEqual(await cacheMatch(miss, "https://flags.internal/config"), none());
  const response = new Response("ok");
  const hit = {
    async match(_request: RequestInfo | URL): Promise<Response | null> {
      return response;
    },
  };
  assert.deepEqual(await cacheMatch(hit, "https://flags.internal/config"), some(response));
  const empty = {
    async get(_key: string): Promise<{ etag: string } | null> {
      return null;
    },
  };
  assert.deepEqual(await r2Get(empty, "flags/config.json"), none());
  const object = { etag: "rev" };
  const bucket = {
    async get(_key: string): Promise<{ etag: string } | null> {
      return object;
    },
  };
  assert.deepEqual(await r2Get(bucket, "flags/config.json"), some(object));
});

test("JSON null is a value and a missing field is none", () => {
  assert.deepEqual(decodeJson("{"), { tag: "invalid", reason: "syntax" });
  assert.deepEqual(decodeJson("null"), { tag: "value", value: null });
  const decoded = decodeJson('{"a":null,"b":1}');
  assert.equal(decoded.tag, "value");
  if (decoded.tag !== "value") return;
  assert.deepEqual(jsonField(decoded.value, "missing"), none());
  assert.deepEqual(jsonField(decoded.value, "a"), some(null));
  assert.deepEqual(jsonField(decoded.value, "b"), some(1));
  assert.deepEqual(jsonField(null, "a"), none());
  assert.deepEqual(jsonField(["a"], "0"), none());
});

test("OTel attribute absence", () => {
  assert.deepEqual(otelAttribute({ "flags.revision": "abc" }, "flags.revision"), some("abc"));
  assert.deepEqual(otelAttribute({ "flags.revision": "abc" }, "flags.unit_id"), none());
  assert.deepEqual(otelAttribute({ "flags.count": 2 }, "flags.count"), some(2));
  assert.deepEqual(otelAttribute({ bad: { nested: true } }, "bad"), none());
  assert.deepEqual(otelAttribute(null, "flags.revision"), none());
  const list = [
    { key: "git.fetch.filter", value: "tree:0" },
    { key: "empty", value: null },
  ];
  assert.deepEqual(otelListField(list, "git.fetch.filter"), some("tree:0"));
  assert.deepEqual(otelListField(list, "empty"), some(null));
  assert.deepEqual(otelListField(list, "missing"), none());
  assert.deepEqual(otelListField(null, "k"), none());
});

test("thrown fields include prototype message", () => {
  const err = Object.assign(new Error("nope"), { code: "not_found" });
  assert.deepEqual(thrownField(err, "code"), some("not_found"));
  assert.deepEqual(thrownField(err, "message"), some("nope"));
  assert.deepEqual(thrownField(err, "status"), none());
  assert.deepEqual(thrownField(null, "code"), none());
  assert.deepEqual(thrownField("x", "code"), none());
});

test("manual init turns none into the host absent value", () => {
  const missing = manualInit({ method: "GET", headers: {}, body: none(), signal: none() });
  assert.equal(missing.method, "GET");
  assert.equal(missing.redirect, "manual");
  assert.equal(isPlatformAbsent(missing.body), true);
  assert.equal(isPlatformAbsent(missing.signal), true);
  const body = new Uint8Array([1]);
  const signal = new AbortController().signal;
  const present = manualInit({
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: some(body),
    signal: some(signal),
  });
  assert.equal(present.body, body);
  assert.equal(present.signal, signal);
});

test("span writers ignore a missing span and a throwing span", () => {
  const seen: string[] = [];
  const span = {
    setAttribute(key: string, value: string | number | boolean): void {
      seen.push(`${key}=${String(value)}`);
    },
    end(): void {
      seen.push("end");
    },
  };
  writeSpanAttribute(span, "flags.cache_status", "HIT");
  writeSpanAttribute(null, "flags.cache_status", "MISS");
  writeSpanAttribute({}, "flags.cache_status", "MISS");
  endOptionalSpan(span);
  endOptionalSpan(null);
  endOptionalSpan({});
  const boom = {
    setAttribute(): void {
      throw new Error("telemetry down");
    },
    end(): void {
      throw new Error("telemetry down");
    },
  };
  writeSpanAttribute(boom, "flags.cache_status", "HIT");
  endOptionalSpan(boom);
  assert.deepEqual(seen, ["flags.cache_status=HIT", "end"]);
});
