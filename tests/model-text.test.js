const { stripLeadingModelControlTags } = require("../server/utils/modelText");

describe("model text cleanup", () => {
  test("strips leaked response status tags from the start of Plato output", () => {
    expect(stripLeadingModelControlTags("[RESPONDING] What do you notice there?"))
      .toBe("What do you notice there?");
    expect(stripLeadingModelControlTags("[responding]: Maya, what word makes you say that?"))
      .toBe("Maya, what word makes you say that?");
  });

  test("does not strip normal bracketed transcript references", () => {
    expect(stripLeadingModelControlTags("[Line 4] seems important."))
      .toBe("[Line 4] seems important.");
  });
});
