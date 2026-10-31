#!/usr/bin/env node
// Compliance audit (docs/09 §2, ADR 0007, ADR 0008). The application itself must contain no AI: no ML packages,
// model files or cloud speech clients. The one exception is the opt-in, self-hosted AI model SERVICE (services/vieneu),
// which must stay isolated and declared. Exits non-zero on any violation; suitable as a CI gate.
// Requires `pnpm build` (uses packages/core/dist). Usage: pnpm audit:compliance
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import core from '../packages/core/dist/index.js';

const root = path.resolve(import.meta.dirname, '..');
const failures = [];
const warnings = [];
const pass = [];
const check = (ok, msg, detail = '') => (ok ? pass : failures).push(detail ? `${msg}: ${detail}` : msg);

// 1. Dependencies: no speech-generation SDKs, ML runtimes, or cloud TTS clients anywhere in the lockfile.
const DENY_PACKAGES = [
  /^@google-cloud\/text-to-speech$/,
  /^@aws-sdk\/client-polly$/,
  /^aws-sdk$/,
  /^microsoft-cognitiveservices-speech-sdk$/,
  /^elevenlabs/,
  /^@elevenlabs\//,
  /^openai$/,
  /^@anthropic-ai\//,
  /^replicate$/,
  /^@huggingface\//,
  /^@xenova\//,
  /^onnxruntime/,
  /^@tensorflow\//,
  /^tfjs/,
  /^@mediapipe\//,
  /^ml5$/,
  /^brain\.js$/,
  /^piper-tts/,
  /^sherpa-onnx/,
  /^coqui/,
  /^whisper/,
  /^@picovoice\//,
  /^say$/,
  /^node-gtts$/,
  /^gtts/,
  /^google-tts-api$/,
  /^flite/,
  /^mbrola/,
];
const lock = readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
const pkgNames = new Set([...lock.matchAll(/^ {2}'?((?:@[^/\s']+\/)?[^@\s':]+)@/gm)].map((m) => m[1]));
const badPkgs = [...pkgNames].filter((n) => DENY_PACKAGES.some((re) => re.test(n)));
check(
  badPkgs.length === 0,
  'No prohibited speech/ML/cloud-TTS packages in lockfile',
  badPkgs.join(', ') || `${pkgNames.size} packages scanned`,
);

// 2. Source and config: no cloud speech endpoints or SDK imports.
const DENY_TEXT = [
  /texttospeech\.googleapis\.com/i,
  /polly\.[a-z0-9-]+\.amazonaws\.com/i,
  /tts\.speech\.microsoft\.com/i,
  /api\.elevenlabs\.io/i,
  /api\.openai\.com\/v1\/audio/i,
  /speechsynthesis\.speak/i,
  /window\.speechSynthesis/i,
];
const SCAN_DIRS = ['apps', 'packages', 'scripts', 'config', 'infra'];
const SKIP = new Set([
  'node_modules',
  'dist',
  '.data',
  'storage',
  'tmp',
  'test-results',
  'playwright-report',
]);
const SELF = path.join(root, 'scripts', 'compliance-audit.mjs');
const hits = [];
function walk(dir, fn) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn);
    else fn(p);
  }
}
for (const d of SCAN_DIRS)
  walk(path.join(root, d), (p) => {
    if (p === SELF || !/\.(ts|tsx|js|mjs|cjs|json|ya?ml|env|conf|Caddyfile|sh)$|Dockerfile|Caddyfile/.test(p))
      return;
    const text = readFileSync(p, 'utf8');
    for (const re of DENY_TEXT) if (re.test(text)) hits.push(`${path.relative(root, p)} (${re.source})`);
  });
check(hits.length === 0, 'No cloud speech endpoints or browser speech synthesis in source', hits.join('; '));

// 3. No ML/neural model files in the repository or installed dependencies.
const MODEL_EXT = /\.(onnx|pt|pth|tflite|safetensors|ckpt|gguf|ggml|rnnn|mlmodel|h5|keras)$/i;
const models = [];
function walkAll(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['.git', '.data', 'storage'].includes(e.name)) walkAll(p);
    } else if (MODEL_EXT.test(e.name)) models.push(path.relative(root, p));
  }
}
walkAll(root);
check(models.length === 0, 'No ML model files in repository or node_modules', models.slice(0, 10).join(', '));

// 4. Runtime tools: approved engine, compliant FFmpeg, no MBROLA voices, no model files in engine data.
const config = core.loadConfig();
const espeak = new core.EspeakAdapter({
  executable: config.tools.espeak,
  approvedVersion: config.espeakApprovedVersion,
});
const espeakOn = config.enabledEngines.includes('espeak');
const health = await espeak.healthCheck().catch((e) => ({ ok: false, version: null, detail: e.message }));
if (espeakOn)
  check(health.ok, `eSpeak NG is the approved version (${config.espeakApprovedVersion})`, health.detail);
else
  pass.push(
    `eSpeak NG is not offered to users (ENABLED_ENGINES=${config.enabledEngines.join(',')}); its data checks below still run if it is installed`,
  );
const ff = await core.inspectFfmpeg(config.tools.ffmpeg).catch((e) => ({ error: e.message }));
if ('error' in ff) check(false, 'FFmpeg available', ff.error);
else {
  check(
    ff.prohibitedFilters.length === 0,
    'FFmpeg build has no speech-generation/ML-runtime filters',
    ff.prohibitedFilters.join(', ') || ff.version,
  );
  if (ff.flaggedFilters.length)
    warnings.push(
      `FFmpeg includes inert filters never invoked by VoxStudio: ${ff.flaggedFilters.join(', ')} (no model files present — see check 3)`,
    );
}
const versionOut = health.ok
  ? (await core.runProcess(config.tools.espeak, ['--version'], { timeoutMs: 10_000 })).stdout.toString()
  : '';
const dataDir = /Data at:\s*(.+)$/m
  .exec(versionOut)?.[1]
  ?.trim()
  .replace(/[\\/]+$/, '');
if (dataDir && existsSync(dataDir)) {
  const mbrola = path.join(dataDir, 'mbrola');
  const mbrolaVoices = existsSync(mbrola)
    ? readdirSync(mbrola).filter((f) => statSync(path.join(mbrola, f)).isFile())
    : [];
  check(mbrolaVoices.length === 0, 'No MBROLA voice databases installed', mbrolaVoices.join(', '));
  const engineModels = [];
  (function w(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) w(p);
      else if (MODEL_EXT.test(e.name)) engineModels.push(e.name);
    }
  })(dataDir);
  check(engineModels.length === 0, 'No model files in eSpeak NG data directory', engineModels.join(', '));
} else warnings.push('Could not locate espeak-ng-data directory for MBROLA/model checks');
if (health.ok) {
  const installed = await espeak.listInstalledVoices();
  check(!installed.some((v) => core.isMbrolaFile(v.file)), 'Adapter never lists MBROLA voices');
}

// 5. Allowlist: every allowlisted voice belongs to an approved engine; QA report matches installed engine.
const allow = core.loadAllowlist(root);
const KNOWN_ENGINES = new Set(['espeak', 'vnunit', 'vieneu']);
check(
  allow.every((v) => KNOWN_ENGINES.has(v.engineId)),
  'Voice allowlist references only engines with an admission record',
  [...new Set(allow.map((v) => v.engineId))].join(', '),
);

// 5a. The AI engine (ADR 0008) stays isolated, declared and internal.
const aiVoices = allow.filter((v) => v.engineId === 'vieneu');
if (aiVoices.length || config.vieneuServiceUrls.length) {
  check(
    existsSync(path.join(root, 'docs', 'decisions', '0008-self-hosted-ai-engine-at-run-time.md')),
    'AI engine has its admission record (ADR 0008)',
  );
  const pnpmWs = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  check(!/services\//.test(pnpmWs), 'The AI model service is not a workspace package of the application');
  const mainIgnore = existsSync(path.join(root, 'infra', 'docker', 'Dockerfile.dockerignore'))
    ? readFileSync(path.join(root, 'infra', 'docker', 'Dockerfile.dockerignore'), 'utf8')
    : '';
  check(/^services$/m.test(mainIgnore), 'The application image excludes the AI model service sources');
  for (const u of config.vieneuServiceUrls) {
    const host = new URL(u).hostname;
    const internal =
      /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
        host,
      ) || !host.includes('.');
    check(internal, 'AI model service URL is on an internal address (no public or external API)', host);
  }
  if (config.vieneuServiceUrls.length)
    check(config.vieneuServiceToken.length >= 16, 'AI model service token is set (at least 16 characters)');
}
if (espeakOn) {
  const qa = core.loadQaReport(root);
  check(
    !!qa && qa.engineVersion === health.version,
    'QA report matches installed engine version',
    qa ? `report ${qa.engineVersion}` : 'missing (run pnpm qa:voices)',
  );
}

// 5b. Vietnamese unit databases: never ship the test fixture, and every database must declare a license.
if (config.vnUnitDbDir) {
  const { readdirSync: ls, existsSync: ex, readFileSync: rf } = await import('node:fs');
  const dirs = ex(path.join(config.vnUnitDbDir, 'manifest.json'))
    ? [config.vnUnitDbDir]
    : ex(config.vnUnitDbDir)
      ? ls(config.vnUnitDbDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(config.vnUnitDbDir, e.name))
      : [];
  const manifests = dirs
    .filter((d) => ex(path.join(d, 'manifest.json')))
    .map((d) => JSON.parse(rf(path.join(d, 'manifest.json'), 'utf8')));
  // ADR 0007: AI-generated source audio is allowed only with a declared, locally run, licensed generator.
  check(
    manifests.every(
      (m) =>
        m.provenance &&
        (m.provenance.kind === 'human-recording' ||
          (m.provenance.kind === 'ai-generated' &&
            m.provenance.generator?.name &&
            m.provenance.generator?.version &&
            m.provenance.generator?.license &&
            m.provenance.generator?.localRun === true)),
    ),
    'Unit databases declare provenance (human recording, or AI-generated with a local, licensed generator)',
    manifests.map((m) => `${m.id}:${m.provenance?.kind ?? 'missing'}`).join(', '),
  );
  check(
    manifests.every((m) => m.license?.id && m.license.id !== 'test-fixture'),
    'Unit databases are licensed recordings, not the test fixture',
    manifests.map((m) => `${m.id}:${m.license?.id}`).join(', '),
  );
}

// 6. Database (optional): enabled engines must be approved.
try {
  const db = await import('../packages/db/dist/index.js');
  const prisma = db.default.createPrisma(config.databaseUrl);
  const bad = await prisma.ttsEngine.findMany({
    where: { enabled: true, NOT: { complianceStatus: 'approved' } },
  });
  check(bad.length === 0, 'No unapproved engine is enabled in the database', bad.map((e) => e.id).join(', '));
  await prisma.$disconnect();
} catch (e) {
  warnings.push(`Database check skipped: ${e.message.split('\n')[0]}`);
}

for (const p of pass) console.log(`PASS  ${p}`);
for (const w of warnings) console.log(`WARN  ${w}`);
for (const f of failures) console.log(`FAIL  ${f}`);
console.log(
  `\n${failures.length ? 'Compliance audit FAILED' : 'Compliance audit passed'} (${pass.length} passed, ${warnings.length} warnings, ${failures.length} failed)`,
);
process.exit(failures.length ? 1 : 0);
