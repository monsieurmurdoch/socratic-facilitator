const express = require('express');
const router = express.Router();
const adminRepo = require('../db/repositories/admin');
const auditLogsRepo = require('../db/repositories/auditLogs');
const modelEvalRunsRepo = require('../db/repositories/modelEvalRuns');
const maintenanceRunsRepo = require('../db/repositories/maintenanceRuns');
const retentionRepo = require('../db/repositories/retention');
const { requireAnyRole, USER_ROLES } = require('../auth');
const { logAudit } = require('../audit');
const { MessageAssessor } = require('../analysis/messageAssessor');
const { runMessageAssessmentEval, MESSAGE_ASSESSMENT_FIXTURES } = require('../analysis/evals/messageAssessmentEval');
const { fastLLM } = require('../analysis/fastLLMProvider');
const { DEFAULT_ANTHROPIC_MODEL, DEFAULT_FAST_LLM_MODEL } = require('../models');

router.use(express.json({ limit: '1mb' }));
router.use(requireAnyRole(['Admin', 'SuperAdmin']));

router.get('/overview', async (req, res) => {
  try {
    const [overview, evalRuns, maintenanceRuns, auditLogs] = await Promise.all([
      adminRepo.getOverview(),
      modelEvalRunsRepo.listRecent('message_assessor', 8),
      maintenanceRunsRepo.listRecent('retention_purge', 6),
      auditLogsRepo.listRecent(20)
    ]);

    res.json({
      ...overview,
      modelHealth: {
        fastLLM: fastLLM.getStats()
      },
      evalRuns: evalRuns.map(run => ({
        id: run.id,
        requestedByName: run.requested_by_name,
        strategy: run.strategy,
        fixtureSet: run.fixture_set,
        modelLabel: run.model_label,
        totalCases: run.total_cases,
        completedCases: run.completed_cases,
        overallScore: run.overall_score == null ? null : Number(run.overall_score),
        metrics: run.metrics,
        createdAt: run.created_at
      })),
      maintenanceRuns: maintenanceRuns.map(run => ({
        id: run.id,
        jobName: run.job_name,
        status: run.status,
        result: run.result_json,
        startedAt: run.started_at,
        finishedAt: run.finished_at
      })),
      auditLogs: auditLogs.map(log => ({
        id: log.id,
        action: log.action,
        entityType: log.entity_type,
        entityId: log.entity_id,
        actorName: log.actor_name,
        actorEmail: log.actor_email,
        targetName: log.target_name,
        targetEmail: log.target_email,
        metadata: log.metadata,
        createdAt: log.created_at
      }))
    });
  } catch (error) {
    console.error('Admin overview error:', error);
    res.status(500).json({ error: 'Failed to load admin overview' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const users = await adminRepo.listUsers(50);
    res.json(users.map(user => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.created_at
    })));
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

router.patch('/users/:id/role', async (req, res) => {
  try {
    const role = String(req.body.role || '').trim();
    if (!USER_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (req.user.role !== 'SuperAdmin' && role === 'SuperAdmin') {
      return res.status(403).json({ error: 'Only a SuperAdmin can assign SuperAdmin' });
    }

    const updated = await adminRepo.updateUserRole(req.params.id, role);
    if (!updated) {
      return res.status(404).json({ error: 'User not found' });
    }

    await logAudit({
      req,
      actorUserId: req.user.id,
      targetUserId: updated.id,
      action: 'admin.user_role_updated',
      entityType: 'user',
      entityId: updated.id,
      metadata: { role }
    });
    res.json(updated);
  } catch (error) {
    console.error('Admin update user role error:', error);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

router.get('/evals/message-assessor', async (req, res) => {
  try {
    const evalRuns = await modelEvalRunsRepo.listRecent('message_assessor', 12);
    res.json({
      fixtureSet: {
        id: 'bootstrap-v1',
        caseCount: MESSAGE_ASSESSMENT_FIXTURES.length
      },
      supportedStrategies: ['heuristic_only', 'auto', 'fast_only', 'claude_only'],
      runs: evalRuns.map(run => ({
        id: run.id,
        requestedByName: run.requested_by_name,
        strategy: run.strategy,
        fixtureSet: run.fixture_set,
        modelLabel: run.model_label,
        totalCases: run.total_cases,
        completedCases: run.completed_cases,
        overallScore: run.overall_score == null ? null : Number(run.overall_score),
        metrics: run.metrics,
        createdAt: run.created_at
      }))
    });
  } catch (error) {
    console.error('Admin eval history error:', error);
    res.status(500).json({ error: 'Failed to load eval history' });
  }
});

router.post('/evals/message-assessor/run', async (req, res) => {
  try {
    const strategy = String(req.body.strategy || 'heuristic_only').trim();
    const allowHeuristicFallback = strategy === 'auto';
    const assessor = new MessageAssessor(process.env.ANTHROPIC_API_KEY);
    const result = await runMessageAssessmentEval({
      assessor,
      strategy,
      allowHeuristicFallback
    });

    const run = await modelEvalRunsRepo.create({
      requestedByUserId: req.user.id,
      evalKey: 'message_assessor',
      strategy,
      fixtureSet: result.fixtureSet,
      modelLabel: strategy === 'claude_only'
        ? (process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL)
        : strategy === 'fast_only'
          ? (process.env.FAST_LLM_MODEL || DEFAULT_FAST_LLM_MODEL)
          : strategy,
      totalCases: result.totalCases,
      completedCases: result.completedCases,
      overallScore: result.metrics.overallScore,
      metrics: result.metrics
    });

    await logAudit({
      req,
      actorUserId: req.user.id,
      action: 'admin.eval_run_created',
      entityType: 'model_eval_run',
      entityId: run.id,
      metadata: { strategy, overallScore: result.metrics.overallScore }
    });

    res.status(201).json({
      run: {
        id: run.id,
        strategy: run.strategy,
        fixtureSet: run.fixture_set,
        modelLabel: run.model_label,
        totalCases: run.total_cases,
        completedCases: run.completed_cases,
        overallScore: run.overall_score == null ? null : Number(run.overall_score),
        createdAt: run.created_at
      },
      result
    });
  } catch (error) {
    console.error('Admin eval run error:', error);
    res.status(500).json({ error: error.message || 'Failed to run evaluation' });
  }
});

router.post('/maintenance/retention/run', async (_req, res) => {
  const startedAt = new Date();
  try {
    const result = await retentionRepo.deleteExpiredSessions(250);
    const run = await maintenanceRunsRepo.create({
      jobName: 'retention_purge',
      status: 'completed',
      result,
      startedAt,
      finishedAt: new Date()
    });
    await logAudit({
      req: _req,
      actorUserId: _req.user.id,
      action: 'admin.retention_purge_run',
      entityType: 'maintenance_run',
      entityId: run.id,
      metadata: result
    });
    res.status(201).json({
      runId: run.id,
      ...result
    });
  } catch (error) {
    await maintenanceRunsRepo.create({
      jobName: 'retention_purge',
      status: 'failed',
      result: { error: error.message },
      startedAt,
      finishedAt: new Date()
    });
    console.error('Admin retention purge error:', error);
    res.status(500).json({ error: error.message || 'Failed to run retention purge' });
  }
});

// FastLLM token availability and usage
router.get('/fastllm-tokens', async (req, res) => {
  try {
    const tokenInfo = await fastLLM.testTokenAvailability();
    res.json(tokenInfo);
  } catch (error) {
    console.error('FastLLM token check error:', error);
    res.status(500).json({ error: error.message || 'Failed to check FastLLM tokens' });
  }
});

module.exports = router;
