const fs = require("fs");
const path = require("path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

describe("backend data pipeline guardrails", () => {
  test("schema has intervention telemetry, label queue, and export consent fields", () => {
    const schema = read("server/db/schema.sql");

    expect(schema).toContain("CREATE TABLE IF NOT EXISTS intervention_telemetry");
    expect(schema).toContain("model TEXT");
    expect(schema).toContain("prompt_version TEXT");
    expect(schema).toContain("estimated_cost_usd");
    expect(schema).toContain("source_chunk_ids UUID[]");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS label_queue_items");
    expect(schema).toContain("eval_consent_granted");
    expect(schema).toContain("allow_eval_export");
  });

  test("session routes expose managed telemetry, label queue, and consent-aware export APIs", () => {
    const source = read("server/routes/sessions.js");
    const routes = [
      "router.get('/:shortCode/intervention-telemetry'",
      "router.post('/:shortCode/label-queue/enqueue'",
      "router.get('/:shortCode/eval-export'",
      "router.patch('/:shortCode/data-use'",
      "router.patch('/:shortCode/participants/:participantId/eval-consent'"
    ];

    for (const route of routes) {
      const routeStart = source.indexOf(route);
      expect(routeStart).toBeGreaterThan(-1);
      const nextRouteStart = source.indexOf("\nrouter.", routeStart + route.length);
      const routeBody = source.slice(routeStart, nextRouteStart === -1 ? source.length : nextRouteStart);
      expect(routeBody).toContain("requireSessionAccess");
    }

    expect(source).toContain("allow_eval_export");
    expect(source).toContain("buildSessionEvalExport");
  });

  test("facilitator writes prompt, cost, move, latency, and source chunk telemetry", () => {
    const engine = read("server/enhancedFacilitator.js");
    const manager = read("server/sessions/index.js");

    expect(engine).toContain("FACILITATION_PROMPT_VERSION");
    expect(engine).toContain("estimatedCostUsd");
    expect(engine).toContain("sourceChunkIds");
    expect(engine).toContain("latencyMs");
    expect(manager).toContain("interventionTelemetryRepo.create");
    expect(manager).toContain("facilitatorMessageId");
    expect(manager).toContain("triggerMessageId");
  });

  test("admin routes expose facilitation eval baseline and human verification queue", () => {
    const source = read("server/routes/admin.js");

    expect(source).toContain("router.get('/evals/facilitation-policy'");
    expect(source).toContain("router.post('/evals/facilitation-policy/run'");
    expect(source).toContain("plato_policy_vs_baselines");
    expect(source).toContain("router.get('/label-queue'");
    expect(source).toContain("router.patch('/label-queue/:id'");
  });

  test("consent export anonymizes speakers and drops unconsented participant turns", async () => {
    jest.resetModules();
    const query = jest.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "session-1",
          short_code: "abc123",
          title: "Test seminar",
          data_use_mode: "eval_export",
          allow_eval_export: true,
          created_at: "2026-04-30T12:00:00.000Z",
          ended_at: "2026-04-30T13:00:00.000Z"
        }]
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "m1",
            sender_type: "facilitator",
            content: "Opening question",
            move_type: "probe",
            created_at: "2026-04-30T12:00:00.000Z",
            participant_id: null,
            eval_consent_granted: null
          },
          {
            id: "m2",
            sender_type: "participant",
            content: "Do not export me",
            move_type: null,
            created_at: "2026-04-30T12:01:00.000Z",
            participant_id: "participant-a",
            eval_consent_granted: false
          },
          {
            id: "m3",
            sender_type: "participant",
            content: "Export me anonymously",
            move_type: null,
            created_at: "2026-04-30T12:02:00.000Z",
            participant_id: "participant-b",
            eval_consent_granted: true,
            specificity: 0.7,
            profoundness: 0.6,
            coherence: 0.8,
            discussion_value: 0.9
          }
        ]
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "it1",
          trigger_message_id: "m3",
          facilitator_message_id: "m4",
          model: "claude-3-5-haiku",
          prompt_version: "facilitation-v1",
          move: "probe",
          latency_ms: 1200,
          input_tokens: 100,
          output_tokens: 40,
          estimated_cost_usd: "0.000240",
          source_chunk_ids: ["chunk-1"],
          decision_json: { interventionType: "probe" },
          created_at: "2026-04-30T12:03:00.000Z"
        }]
      });

    jest.doMock("../server/db/index", () => ({ query }));
    const repo = require("../server/db/repositories/consentExports");
    const payload = await repo.buildSessionEvalExport("session-1");

    expect(payload.turns.map(turn => turn.text)).toEqual([
      "Opening question",
      "Export me anonymously"
    ]);
    expect(payload.turns[1].speakerId).toBe("speaker_001");
    expect(payload.consent.excludedUnconsentedTurns).toBe(1);
    expect(payload.consent.exportedSpeakerCount).toBe(1);
    expect(payload.interventions[0]).toEqual(expect.objectContaining({
      model: "claude-3-5-haiku",
      promptVersion: "facilitation-v1",
      move: "probe",
      sourceChunkIds: ["chunk-1"]
    }));
  });
});
