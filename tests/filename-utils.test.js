import assert from "node:assert/strict";
import test from "node:test";
import { decodeMultipartFileName } from "../src/filename-utils.js";

test("multipart filenames recover UTF-8 names decoded as Latin-1", () => {
  const fileName = "服务代理导出_20260701.xlsx";
  const multerValue = Buffer.from(fileName, "utf8").toString("latin1");

  assert.equal(decodeMultipartFileName(multerValue), fileName);
});

test("multipart filename decoding preserves ASCII and actual Latin-1 names", () => {
  assert.equal(decodeMultipartFileName("contract.xlsx"), "contract.xlsx");
  assert.equal(decodeMultipartFileName("caf\u00e9.txt"), "caf\u00e9.txt");
});
