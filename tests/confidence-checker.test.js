jest.mock("../server/analysis/fastLLMProvider", () => ({
  fastLLM: {
    completeJSON: jest.fn().mockResolvedValue({
      data: {
        confidence: 0.61,
        reasoning: "Looks complete enough",
        isReady: true
      }
    })
  }
}));

const { fastLLM } = require("../server/analysis/fastLLMProvider");
const { ConfidenceChecker } = require("../server/confidence-checker");

describe("ConfidenceChecker", () => {
  beforeEach(() => {
    fastLLM.completeJSON.mockClear();
  });

  test("uses cheap heuristic for complete short greeting/question", async () => {
    const checker = new ConfidenceChecker();
    const result = await checker.assessConfidence("Howdy, how's it going?");

    expect(result.isReady).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.7);
    expect(fastLLM.completeJSON).not.toHaveBeenCalled();
  });

  test("skips duplicate interim transcript spam", async () => {
    const checker = new ConfidenceChecker();
    await checker.assessConfidence("Can you hear me");
    const result = await checker.assessConfidence("Can you hear me");

    expect(result.isReady).toBe(false);
    expect(result.reasoning).toMatch(/duplicate/i);
  });

  test("falls through to fast model for longer ambiguous interim speech", async () => {
    const checker = new ConfidenceChecker();
    const result = await checker.assessConfidence("I think what I mean is that maybe Achilles is actually");

    expect(fastLLM.completeJSON).toHaveBeenCalled();
    expect(result.isReady).toBe(true);
  });
});
