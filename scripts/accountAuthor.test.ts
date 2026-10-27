import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readGitAuthor, saveGitAuthor } from "../src/accountAuthor.ts";

const data = new Map<string,string>();
Object.defineProperty(globalThis, "localStorage", { value: { getItem: (k:string) => data.get(k) ?? null, setItem: (k:string,v:string) => data.set(k,v), removeItem: (k:string) => data.delete(k) }, configurable: true });

test("author preference persists and can be removed without secrets", () => {
  assert.equal(readGitAuthor(), null);
  saveGitAuthor({name:"  Fixture Author  ",email:" fixture@example.test "});
  assert.deepEqual(readGitAuthor(), {name:"Fixture Author",email:"fixture@example.test"});
  saveGitAuthor(null);
  assert.equal(readGitAuthor(), null);
});
