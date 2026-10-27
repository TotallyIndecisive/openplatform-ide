import { test } from "node:test";
import { strict as assert } from "node:assert";
import { lastSignedIn } from "../src/accountTime.ts";

test("last sign-in updates only after each full 24-hour period", () => {
  const start = 1_700_000_000_000;
  assert.equal(lastSignedIn(null, start), "Not recorded");
  assert.equal(lastSignedIn(start + 1, start), "Not recorded");
  assert.equal(lastSignedIn(start, start + 86_399_999), "Less than a day ago");
  assert.equal(lastSignedIn(start, start + 86_400_000), "1 day ago");
  assert.equal(lastSignedIn(start, start + 172_800_000), "2 days ago");
});
