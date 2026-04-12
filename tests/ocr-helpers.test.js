const {
  looksLikeWeakPDFExtraction
} = require("../server/content/ocr");

describe("ocr helpers", () => {
  test("flags very weak extracted pdf text", () => {
    expect(looksLikeWeakPDFExtraction("x x x x\nx x x", { pages: 2 })).toBe(true);
  });

  test("accepts healthy born-digital extraction", () => {
    const text = [
      "Sing, goddess, the anger of Peleus' son Achilles,",
      "that brought countless ills upon the Achaeans,",
      "and sent many mighty souls to Hades."
    ].join("\n");

    expect(looksLikeWeakPDFExtraction(text, { pages: 1 })).toBe(false);
  });
});
