const SPEECH_PATIENCE_PRESETS = {
  quick: {
    mode: "quick",
    label: "Quick",
    warmupMergeMs: 600,
    warmupSettleMs: 280
  },
  balanced: {
    mode: "balanced",
    label: "Balanced",
    warmupMergeMs: 1100,
    warmupSettleMs: 450
  },
  patient: {
    mode: "patient",
    label: "Patient",
    warmupMergeMs: 1700,
    warmupSettleMs: 750
  }
};

function normalizeSpeechPatienceMode(mode) {
  const value = String(mode || "").trim().toLowerCase();
  if (value === "quick" || value === "patient" || value === "balanced") {
    return value;
  }
  return "balanced";
}

function getSpeechPatiencePreset(mode) {
  return SPEECH_PATIENCE_PRESETS[normalizeSpeechPatienceMode(mode)];
}

module.exports = {
  SPEECH_PATIENCE_PRESETS,
  normalizeSpeechPatienceMode,
  getSpeechPatiencePreset
};
