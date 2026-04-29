import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { runFacilitationPolicyEval } = require('../server/analysis/evals/facilitationPolicyEval');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outputDir = path.join(root, 'output', 'evals');

function hasFlag(name) {
  return process.argv.includes(name);
}

function formatCandidate(candidate) {
  const metrics = candidate.metrics;
  return [
    `${candidate.label} (${candidate.candidateId})`,
    `  overall=${metrics.overallScore}`,
    `  timing=${metrics.timingAccuracy}`,
    `  move=${metrics.moveAccuracy}`,
    `  target=${metrics.targetAccuracy}`,
    `  overtalk=${metrics.overtalkRate}`,
    `  missed=${metrics.missedInterventionRate}`,
    `  completed=${candidate.completedCases}/${candidate.totalCases}`
  ].join('\n');
}

async function main() {
  const result = await runFacilitationPolicyEval();

  await fs.mkdir(outputDir, { recursive: true });
  const latestPath = path.join(outputDir, 'facilitation-policy-latest.json');
  const datedPath = path.join(outputDir, `facilitation-policy-${Date.now()}.json`);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  await fs.writeFile(latestPath, serialized, 'utf8');
  await fs.writeFile(datedPath, serialized, 'utf8');

  if (hasFlag('--json')) {
    process.stdout.write(serialized);
    return;
  }

  console.log('Facilitation policy eval');
  console.log(`Fixture set: ${result.fixtureSet}`);
  console.log(`Cases: ${result.totalCases}`);
  console.log(`Winner: ${result.metrics.winner}`);
  console.log(`Plato score: ${result.metrics.platoScore}`);
  console.log(`Best baseline: ${result.metrics.bestBaseline} (${result.metrics.bestBaselineScore})`);
  console.log(`Lift vs best baseline: ${result.metrics.liftVsBestBaseline}`);
  console.log('');
  for (const candidate of result.candidates) {
    console.log(formatCandidate(candidate));
    console.log('');
  }
  console.log(`Wrote ${latestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
