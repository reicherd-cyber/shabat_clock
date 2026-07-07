// [D23] canonical schedule-payload string + SHA-256 — byte-exact contract with the
// server (src/services/schedulePayload.js). Built by snprintf-style concatenation
// from parsed values; NEVER hash the wire bytes.
#pragma once
#include <ArduinoJson.h>
#include <mbedtls/sha256.h>
#include <string>

inline void canonicalAppendInt(std::string& s, long v) {
  char buf[16];
  snprintf(buf, sizeof(buf), "%ld", v);
  s += buf;
}

// Rebuild the canonical string from a parsed schedule payload (without "sha256").
inline std::string canonicalString(JsonObjectConst p) {
  std::string s = "{\"version\":";
  canonicalAppendInt(s, p["version"].as<long>());
  s += ",\"tz\":\"";
  s += p["tz"].as<const char*>();
  s += "\",\"relays\":[";
  bool first = true;
  for (JsonObjectConst r : p["relays"].as<JsonArrayConst>()) {
    if (!first) s += ',';
    first = false;
    s += "{\"no\":";
    canonicalAppendInt(s, r["no"].as<long>());
    s += ",\"boot\":\"";
    s += r["boot"].as<const char*>();
    s += "\"}";
  }
  s += "],\"events\":[";
  first = true;
  for (JsonObjectConst e : p["events"].as<JsonArrayConst>()) {
    if (!first) s += ',';
    first = false;
    s += "{\"sid\":";
    canonicalAppendInt(s, e["sid"].as<long>());
    s += ",\"relay\":";
    canonicalAppendInt(s, e["relay"].as<long>());
    s += ",\"day\":";
    canonicalAppendInt(s, e["day"].as<long>());
    s += ",\"time\":\"";
    s += e["time"].as<const char*>();
    s += "\",\"action\":\"";
    s += e["action"].as<const char*>();
    s += "\"}";
  }
  s += "],\"once\":[";
  first = true;
  for (JsonObjectConst o : p["once"].as<JsonArrayConst>()) {
    if (!first) s += ',';
    first = false;
    s += "{\"sid\":";
    canonicalAppendInt(s, o["sid"].as<long>());
    s += ",\"relay\":";
    canonicalAppendInt(s, o["relay"].as<long>());
    s += ",\"date\":\"";
    s += o["date"].as<const char*>();
    s += "\",\"time\":\"";
    s += o["time"].as<const char*>();
    s += "\",\"action\":\"";
    s += o["action"].as<const char*>();
    s += "\"}";
  }
  s += "]}";
  return s;
}

inline std::string sha256hex(const std::string& input) {
  unsigned char hash[32];
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);
  mbedtls_sha256_update(&ctx, (const unsigned char*)input.data(), input.size());
  mbedtls_sha256_finish(&ctx, hash);
  mbedtls_sha256_free(&ctx);
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.reserve(64);
  for (int i = 0; i < 32; i++) {
    out += hex[hash[i] >> 4];
    out += hex[hash[i] & 0xF];
  }
  return out;
}
