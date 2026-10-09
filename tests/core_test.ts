import {
  edits,
  forms,
  LRU,
  matchReading,
  matchReadingDetails,
  normalizedKeys,
} from "../lime/ime/primitives.ts";
import { LearningStore } from "../lime/ime/learning.ts";
function assert(ok: unknown, message = "assertion failed"): asserts ok {
  if (!ok) throw Error(message);
}
Deno.test("pinyin accepts mixed initials, rejects a wrong complete pronunciation", () => {
  const readings = forms(["shu", "ru", "fa"]);
  assert(readings.some((r) => matchReading("shurf", r) === 5));
  assert(readings.some((r) => matchReading("srf", r) === 3));
  assert(!forms(["shi"]).some((r) => matchReading("si", r) === 2));
  assert(
    matchReading("ni", { pieces: ["ni", "hao"], abbreviated: 0 }) === 0,
    "must not complete untyped syllables",
  );
  assert(matchReading("niha", { pieces: ["ni", "hao"], abbreviated: 0 }) === 4);
  const parsed = normalizedKeys("Ni'Hao");
  assert(parsed?.keys === "nihao" && parsed.ends[4] === 6);
  assert(normalizedKeys("你") === null);
  assert(
    matchReadingDetails("cha", { pieces: ["cha"], abbreviated: 0 })
      .completion === false,
  );
  assert(
    matchReadingDetails("cha", { pieces: ["chang"], abbreviated: 0 })
      .completion === true,
  );
  assert(
    matchReadingDetails("xian", { pieces: ["xian"], abbreviated: 0 }, [2])
      .consumed === 0,
  );
  assert(
    matchReadingDetails("xian", { pieces: ["xi", "an"], abbreviated: 0 }, [2])
      .consumed === 4,
  );
  assert(normalizedKeys("xi'an")?.ends[1] === 3);
  assert(edits("shurfa").includes("shurufa"));
  assert(edits("diannoa").includes("diannao"));
});
Deno.test("LRU retains recent prefixes and evicts old ones", () => {
  const cache = new LRU<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  assert(cache.get("a") === 1);
  cache.set("c", 3);
  assert(cache.get("b") === undefined);
});
Deno.test("learning survives restart, bounded bonus, reversible delete, pause", () => {
  const path = Deno.makeTempDirSync();
  const file = new URL(
    "file:///" + path.replaceAll("\\", "/") + "/learning.json",
  );
  try {
    let store = new LearningStore(file);
    for (let i = 0; i < 100; i++) store.learn("ceshi", "测试");
    assert(store.bonus("ceshi", "测试") <= 1.5);
    store = new LearningStore(file);
    assert(store.list().entries[0].count === 100);
    const id = store.list().entries[0].id;
    store.change("remove", id);
    assert(store.list().entries.length === 0);
    store.change("undo");
    assert(store.list().entries.length === 1);
    store.change("pause");
    store.learn("x", "新");
    assert(store.list().entries.length === 1);
    store.change("clear");
    assert(store.list().entries.length === 0);
    store.change("undo");
    assert(store.list().entries.length === 1);
  } finally {
    Deno.removeSync(path, { recursive: true });
  }
});
