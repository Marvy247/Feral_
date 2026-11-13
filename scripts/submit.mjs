#!/usr/bin/env node
/**
 * Submission helper for NEAR HACKATHON.
 *
 * The form accepts one submission per team and cannot be edited afterwards, so
 * this script validates every field against the published contract before
 * anything leaves the machine, prints the exact payload for a human to read,
 * and only sends when told to with `--send`.
 *
 *   node scripts/submit.mjs                 # validate submission.json and print the payload
 *   node scripts/submit.mjs --send          # POST it (asks for confirmation first)
 *   node scripts/submit.mjs --send --yes    # POST without the interactive prompt (CI)
 *
 * Contract: https://nearhackathon.com/HACKATHON.md
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const ENDPOINT = 'https://nearhackathon.com/api/applications';
const TRACKS = [
  'defi', 'thesis', 'privacy', 'business', 'swarms', 'security', 'agents',
  'realworld', 'games', 'nfts', 'memecoins', 'social', 'open',
];
const SIZES = ['1', '2 - 4', '4 - 6', '6 - 8', '8+'];
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+[-_])*[a-z\d]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const file = process.argv.includes('--file')
  ? process.argv[process.argv.indexOf('--file') + 1]
  : 'submission.json';

if (!existsSync(file)) {
  console.error(`no ${file}. Copy submission.example.json and fill every field by hand.`);
  process.exit(2);
}

const raw = readFileSync(file, 'utf8');
const errors = [];
const warnings = [];

let payload;
try {
  payload = JSON.parse(raw);
} catch (error) {
  console.error(`${file} is not valid JSON: ${error.message}`);
  process.exit(2);
}

const requireString = (key, { min = 1, max = 2000, pattern = null, label = key } = {}) => {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${label} is required`);
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length < min) errors.push(`${label} must be at least ${min} characters`);
  if (trimmed.length > max) errors.push(`${label} must be at most ${max} characters`);
  if (pattern && !pattern.test(trimmed)) errors.push(`${label} does not look valid`);
};

requireString('projectName', { min: 2, max: 80, label: 'project name' });
requireString('teamLead', { min: 2, max: 80, label: 'team lead' });
requireString('email', { max: 160, pattern: EMAIL_RE, label: 'email address' });
requireString('nearAccount', { min: 2, max: 64, pattern: ACCOUNT_RE, label: 'NEAR account' });
requireString('repositoryUrl', { max: 300, pattern: /^https:\/\//, label: 'repository link' });
requireString('demoUrl', { max: 300, pattern: /^https:\/\//, label: 'demo post link' });
requireString('idea', { min: 20, max: 2000, label: 'what did you build' });

if (!SIZES.includes(payload.size)) {
  errors.push(`team size must be one of: ${SIZES.join(' | ')}`);
}

const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
if (tracks.length === 0) errors.push('choose at least one track');
for (const track of tracks) {
  if (!TRACKS.includes(track)) errors.push(`unknown track "${track}"`);
}

// A repository must be public: the judges cannot open a private one.
if (typeof payload.repositoryUrl === 'string' && payload.repositoryUrl.includes('github.com')) {
  if (payload.repositoryUrl.includes('/-/') || payload.repositoryUrl.endsWith('/-/settings')) {
    warnings.push('the repository link looks like a settings page, not the repository root');
  }
}

// The demo post has to carry the tags, or it does not reach the timeline.
if (typeof payload.demoUrl === 'string' && /x\.com|twitter\.com/.test(payload.demoUrl)) {
  if (!/status\/\d+/.test(payload.demoUrl)) {
    warnings.push('the demo link does not look like a post (expected .../status/<id>)');
  }
  warnings.push('check the post says it was built at NEAR HACKATHON and tags @NEARProtocol and #NEARHackathon');
}

// The idea text should say what NEAR is for, in concrete terms.
if (typeof payload.idea === 'string' && !/near/i.test(payload.idea)) {
  warnings.push('the description does not mention NEAR');
}

if (payload.consent !== true) {
  errors.push('consent must be true: the organizers may use these details to review the submission and contact the team');
}

if (typeof payload.requestId !== 'string' || !UUID_RE.test(payload.requestId)) {
  payload.requestId = randomUUID();
  warnings.push(`no requestId in ${file}; using ${payload.requestId} (a retry with the same id is safe)`);
}

const shape = {
  projectName: payload.projectName,
  teamLead: payload.teamLead,
  email: payload.email,
  size: payload.size,
  tracks,
  nearAccount: payload.nearAccount,
  repositoryUrl: payload.repositoryUrl,
  demoUrl: payload.demoUrl,
  idea: payload.idea,
  consent: payload.consent,
  requestId: payload.requestId,
};

console.log('');
console.log('NEAR HACKATHON - submission payload');
console.log('-'.repeat(72));
console.log(JSON.stringify(shape, null, 2));
console.log('-'.repeat(72));

if (warnings.length > 0) {
  console.log('warnings:');
  for (const warning of warnings) console.log(`  - ${warning}`);
  console.log('');
}

if (errors.length > 0) {
  console.error('the payload is not valid:');
  for (const error of errors) console.error(`  - ${error}`);
  console.error('');
  console.error(`fix ${file} and run this again. Nothing was sent.`);
  process.exit(1);
}

console.log('the payload is valid against the published contract.');

const shouldSend = process.argv.includes('--send');
if (!shouldSend) {
  console.log('nothing was sent. Run with --send when a human has read the payload above.');
  process.exit(0);
}

if (!process.argv.includes('--yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Type the project name ("${shape.projectName}") to send it: `);
  rl.close();
  if (answer.trim() !== shape.projectName) {
    console.log('not sent.');
    process.exit(1);
  }
}

const response = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(shape),
});

const text = await response.text();
console.log(`HTTP ${response.status}`);
console.log(text);

if (response.ok) {
  console.log('');
  console.log('submitted. It cannot be edited: if something is wrong, use https://nearhackathon.com/request-changes');
  console.log('keep the repository public and the demo post up until the results are announced.');
} else {
  console.error('the submission was rejected. Nothing was changed; fix the fields and try again.');
  process.exit(1);
}
