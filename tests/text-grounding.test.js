const {
  buildChunksFromText,
  normalizeToLines,
  formatChunksForPrompt
} = require("../server/content/textGrounding");

describe("text grounding", () => {
  test("preserves explicit lines and numbers canonically", () => {
    const lines = normalizeToLines("1. Sing, goddess\n2. of the rage\n3. of Achilles");
    expect(lines).toEqual(["Sing, goddess", "of the rage", "of Achilles"]);
  });

  test("builds stable line-addressable chunks", () => {
    const chunks = buildChunksFromText(
      "Sing, goddess, of the rage of Achilles\nthat cost the Achaeans countless losses\nand hurled down to Hades many valiant souls.",
      { maxLines: 2 }
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0].lineStart).toBe(1);
    expect(chunks[0].lineEnd).toBe(2);
    expect(chunks[1].lineStart).toBe(3);
  });

  test("formats chunks for prompt grounding", () => {
    const prompt = formatChunksForPrompt([
      { lineStart: 4, lineEnd: 6, content: "Achilles chose wrath over restraint." }
    ]);

    expect(prompt).toMatch(/lines 4-6/);
    expect(prompt).toMatch(/Achilles chose wrath/);
  });
});
