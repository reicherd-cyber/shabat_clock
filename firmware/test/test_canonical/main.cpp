// [D23] canonical-hash test vector — must pass in firmware CI (on-target: pio test).
#include <Arduino.h>
#include <unity.h>
#include <ArduinoJson.h>
#include "../../src/canonical.h"

void test_vector() {
  const char* json =
    "{\"version\":1,\"tz\":\"Asia/Jerusalem\","
    "\"relays\":[{\"no\":1,\"boot\":\"schedule\"}],"
    "\"events\":[{\"sid\":1,\"relay\":1,\"day\":6,\"time\":\"18:00\",\"action\":\"on\"},"
    "{\"sid\":1,\"relay\":1,\"day\":7,\"time\":\"20:00\",\"action\":\"off\"}],"
    "\"once\":[]}";
  JsonDocument doc;
  TEST_ASSERT_EQUAL(DeserializationError::Ok, deserializeJson(doc, json));
  std::string canon = canonicalString(doc.as<JsonObjectConst>());
  TEST_ASSERT_EQUAL_STRING(json, canon.c_str());
  TEST_ASSERT_EQUAL_STRING(
    "32cbd8e3bb7a613d6c8ea8d452ea84ff656b5607373bccfca65f9fba45f6fcc4",
    sha256hex(canon).c_str());
}

void setup() {
  delay(2000);
  UNITY_BEGIN();
  RUN_TEST(test_vector);
  UNITY_END();
}

void loop() {}
