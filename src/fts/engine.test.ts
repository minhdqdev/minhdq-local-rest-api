import { SearchIndex, type SearchDocument, type SearchOptions } from "./engine";
import { findMatches } from "./matches";
import { accentKey, foldKey } from "./text";

const assert = {
  equal: (a: unknown, b: unknown) => expect(a).toBe(b),
  notEqual: (a: unknown, b: unknown) => expect(a).not.toBe(b),
  deepEqual: (a: unknown, b: unknown) => expect(a).toEqual(b),
  ok: (v: unknown) => expect(v).toBeTruthy(),
  match: (s: string, re: RegExp) => expect(s).toMatch(re),
};

// Fixtures modelled on real notes in the vault, including the noisy ones that
// Obsidian's simple search ranked above the right answer.
const docs: SearchDocument[] = [
  {
    path: "Nguồn cung sản phẩm công nghệ ngách.md",
    title: "Nguồn cung sản phẩm công nghệ ngách",
    tags: ["business"],
    body: "## Introduction\nTìm nhà cung cấp cho dòng hàng công nghệ ngách như keycap, phụ kiện bàn phím.\n## Taobao\nĐặt hàng qua trung gian.",
  },
  {
    path: "Resources/GameFi.md",
    title: "GameFi",
    tags: ["blockchain"],
    body: "- Sử dụng NFT để đảm bảo vật phẩm là độc nhất\n- Người dùng có thể kiếm tiền\nHành vi người dùng sẽ thay đổi, từ pay to win chuyển sang pay to earn.",
  },
  {
    path: "Resources/Agent2Agent.md",
    title: "Agent2Agent",
    tags: ["AI"],
    body: "A2A cung cấp một ngôn ngữ chung để các agent có thể khám phá khả năng của nhau và cùng nhau thực hiện các nhiệm vụ phức tạp.",
  },
  {
    path: "Resources/Prompt engineering.md",
    title: "Prompt engineering",
    body: "- Constraints: ràng buộc về thời gian, nguồn lực, format\nContextualization: Cung cấp cho AI đủ thông tin.",
  },
  {
    path: "Projects/King Keycap Store.md",
    title: "King Keycap Store",
    tags: ["project"],
    body: "Bàn phím cơ là dòng sản phẩm khá ngách để thành công cho dropshipping. Sản phẩm, sản phẩm, sản phẩm.",
  },
  {
    path: "Resources/Quy trình làm sản phẩm số.md",
    title: "Quy trình làm sản phẩm số",
    body: "Các bước làm sản phẩm số từ ý tưởng tới launch.",
  },
  {
    path: "Resources/Thể chế hoá.md",
    title: "Thể chế hoá",
    body: "Thể chế hoá là quá trình biến chủ trương thành văn bản pháp luật.",
  },
  {
    path: "Resources/Thể chế hóa.md",
    title: "Thể chế hóa",
    body: "Bản trùng, viết dấu kiểu mới.",
  },
  {
    path: "Personal Dashboard.md",
    title: "Personal Dashboard",
    body: "Làm thế nào để nó check được version mới nhất. Chế độ tối.",
  },
  {
    path: "Resources/Kinh nghiệm thuê nhà.md",
    title: "Kinh nghiệm thuê nhà",
    body: "Kiểm tra hợp đồng, đặt cọc, điện nước.",
  },
  {
    path: "Idempotency API.md",
    title: "Idempotency API",
    aliases: ["Idempotency key"],
    body: "Dùng Idempotency-Key header để retry an toàn.",
  },
  {
    path: "Resources/Idempotency.md",
    title: "Idempotency",
    body: "An operation is idempotent if applying it twice has the same effect. API retry.",
  },
  {
    // Filename stored decomposed (NFD), as macOS file systems sometimes return it.
    path: "Resources/Tục ngữ.md".normalize("NFD"),
    title: "Tục ngữ".normalize("NFD"),
    body: "Ăn quả nhớ kẻ trồng cây.".normalize("NFD"),
  },
  {
    path: "Resources/Retrieval-Augmented Generation.md",
    title: "Retrieval-Augmented Generation",
    aliases: ["RAG"],
    tags: ["ai/rag"],
    body: "## Vector search\nChunk tài liệu rồi embed.\n## Vectorless\nPageIndex dựng cây mục lục.",
  },
];

// Pad with noise so IDF behaves like a real vault: lots of notes mention
// "sản phẩm", "cùng", "cung cấp", "nguồn".
for (let i = 0; i < 60; i++) {
  docs.push({
    path: `Resources/Noise ${i}.md`,
    title: `Ghi chú ${i}`,
    body: [
      "Chúng ta cùng nhau làm sản phẩm.",
      "Nhà cung cấp dịch vụ cloud.",
      "Mã nguồn mở và nguồn lực.",
      "Thế giới mở, chế độ chơi.",
    ][i % 4],
  });
}

const index = new SearchIndex();
for (const d of docs) index.upsert(d);
const top = (q: string, opts?: SearchOptions) => index.search(q, opts).hits.map((h) => h.path);

test("keys: tone placement and folding", () => {
  assert.equal(accentKey("hoá"), accentKey("hóa"));
  assert.notEqual(accentKey("cung"), accentKey("cùng"));
  assert.equal(foldKey("sản"), "san");
  assert.equal(foldKey("đồng"), "dong");
});

test("exact phrase in title ranks first (the case simple search failed)", () => {
  assert.equal(top("Nguồn cung sản phẩm")[0], "Nguồn cung sản phẩm công nghệ ngách.md");
});

test("unaccented typing still finds the note", () => {
  assert.equal(top("nguon cung san pham")[0], "Nguồn cung sản phẩm công nghệ ngách.md");
});

test("'cung' with no accent does not promote notes that only contain 'cùng'", () => {
  const hits = top("Nguồn cung sản phẩm", { limit: 5 });
  assert.ok(!hits.slice(0, 3).includes("Resources/Agent2Agent.md"));
  assert.ok(!hits.slice(0, 3).includes("Resources/GameFi.md"));
});

test("old and new tone placement both hit both duplicates", () => {
  const a = top("thể chế hóa", { limit: 2 }).sort();
  const b = top("thể chế hoá", { limit: 2 }).sort();
  assert.deepEqual(a, ["Resources/Thể chế hoá.md", "Resources/Thể chế hóa.md"]);
  assert.deepEqual(b, a);
});

test("'thể chế' does not get beaten by 'thế' / 'chế độ'", () => {
  const hits = top("thể chế hóa", { limit: 3 });
  assert.ok(!hits.includes("Personal Dashboard.md"));
});

test("English + alias", () => {
  assert.equal(top("idempotency key")[0], "Idempotency API.md");
  assert.equal(top("RAG")[0], "Resources/Retrieval-Augmented Generation.md");
});

test("NFD filenames and content are searchable with NFC queries", () => {
  assert.equal(top("tục ngữ")[0].normalize("NFC"), "Resources/Tục ngữ.md");
  assert.equal(top("trồng cây")[0].normalize("NFC"), "Resources/Tục ngữ.md");
});

test("path and tag filters", () => {
  assert.deepEqual(top("sản phẩm", { path: "projects" }), ["Projects/King Keycap Store.md"]);
  assert.equal(top("vectorless", { tags: ["ai"] })[0], "Resources/Retrieval-Augmented Generation.md");
  assert.equal(top("vectorless", { tags: ["business"] }).length, 0);
});

test("remove and rename keep the index consistent", () => {
  const idx = new SearchIndex();
  idx.upsert({ path: "a.md", title: "Kinh nghiệm thuê nhà", body: "" });
  idx.rename("a.md", { path: "b.md", title: "Kinh nghiệm thuê nhà", body: "" });
  assert.deepEqual(idx.search("thuê nhà").hits.map((h) => h.path), ["b.md"]);
  idx.remove("b.md");
  assert.equal(idx.search("thuê nhà").total, 0);
  assert.equal(idx.size, 0);
});

test("findMatches reports a phrase once, best first", () => {
  const text = "Nhà cung cấp. Nguồn cung sản phẩm công nghệ. Sản phẩm.";
  const spans = findMatches(text, "nguồn cung sản phẩm");
  expect(text.slice(spans[0].start, spans[0].end)).toBe("Nguồn cung sản phẩm");
  // Then the two-word run "Sản phẩm", then the lone "cung" from "cung cấp".
  expect(spans.slice(1).map((s) => text.slice(s.start, s.end))).toEqual(["Sản phẩm", "cung"]);
});

test("findMatches offsets point into decomposed (NFD) text", () => {
  const text = "Ăn quả nhớ kẻ trồng cây".normalize("NFD");
  const [span] = findMatches(text, "trồng cây");
  expect(text.slice(span.start, span.end).normalize("NFC")).toBe("trồng cây");
});
