require('dotenv').config();

const { MessageAssessor } = require('../messageAssessor');
const { runMessageAssessmentEval } = require('../evals/messageAssessmentEval');

async function main() {
  const strategy = process.argv.find(arg => arg.startsWith('--strategy='))?.split('=')[1] || 'heuristic_only';
  const assessor = new MessageAssessor(process.env.ANTHROPIC_API_KEY);
  const result = await runMessageAssessmentEval({
    assessor,
    strategy,
    allowHeuristicFallback: strategy === 'auto'
  });

  console.log(JSON.stringify({
    strategy: result.strategy,
    totalCases: result.totalCases,
    completedCases: result.completedCases,
    failureCount: result.failureCount,
    availability: result.availability,
    sourceBreakdown: result.sourceBreakdown,
    metrics: result.metrics,
    failures: result.failures
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
