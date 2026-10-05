import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBase64Media } from "../src/sdk/base64.js";

void test("accepts both a typed data URI and bare Base64 with an explicit type", () => {
  for (const value of ["AQIDBA==", "AQIDBA"]) {
    assert.deepEqual([...decodeBase64Media(value, "image/png").data], [1, 2, 3, 4]);
  }
  const media = decodeBase64Media("data:image/png;base64,AQIDBA==");
  assert.equal(media.contentType, "image/png");
  assert.deepEqual([...media.data], [1, 2, 3, 4]);
});

void test("reference documents decode like any other upload type, without the 10 MiB image limit", () => {
  const pdf = decodeBase64Media("data:application/pdf;base64,JVBERi0=");
  assert.equal(pdf.contentType, "application/pdf");
  assert.equal(pdf.data.toString("latin1"), "%PDF-");
  const text = decodeBase64Media("aGk=", "text/plain");
  assert.equal(text.data.toString("utf8"), "hi");
  // 11.1 MB: over the image limit, inside the 90 MiB limit documents share with audio and video.
  const overImageLimit = "A".repeat(4 * 3_700_000);
  assert.equal(decodeBase64Media(overImageLimit, "application/pdf").data.byteLength, 11_100_000);
  assert.throws(() => decodeBase64Media(overImageLimit, "image/png"), /size limit/);
});

void test("rejects an ambiguous type, corrupt encoding and oversized content, without relying on Buffer's lenient decoding", () => {
  assert.throws(() => decodeBase64Media("AQIDBA=="), /contentType/);
  assert.throws(() => decodeBase64Media("data:text/html;base64,AQIDBA=="), /contentType/);
  assert.throws(
    () => decodeBase64Media("data:image/png;base64,AQIDBA==", "image/jpeg"),
    /does not match/,
  );
  for (const value of [
    "",
    "A",
    "AQ=Z",
    "AQ===",
    "A!ID",
    "AR==",
    "AQJ=",
    "data:image/png,AQIDBA==",
  ]) {
    assert.throws(() => decodeBase64Media(value, "image/png"), TypeError, value);
  }
  assert.throws(
    () => decodeBase64Media("A".repeat(Math.ceil((10 * 1024 * 1024) / 3) * 4 + 1), "image/png"),
    /size limit/,
  );
});
