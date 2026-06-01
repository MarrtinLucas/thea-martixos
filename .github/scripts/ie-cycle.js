// Thea Intelligence Engine v3 — Autonomous Learning Engine
// GitHub Actions · Node 24 · ESM · Runs every 20 min · No browser needed
// Phi-3.5 via Ollama for synthesis · 8 research sources · Self-directing topic registry

import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
// Stage 4.5 — Thea's open-mind upgrade
// brain-core provides deterministic 10D coord computation and discipline
// classification. Same source of truth as the browser runtime.
//
// HARDENING 2026-04-19: The require is wrapped so a missing brain-core.js
// file (e.g. not yet committed into .github/scripts/) downgrades the cycle
// to research-only + safe-default coord atoms instead of crashing the whole
// GitHub Action. buildAtom() already has a try/catch around brainCore.*
// calls — this guard just ensures the import itself is survivable.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let brainCore = null;
try {
  brainCore = require('./brain-core.cjs');
  console.log('[IE] brain-core.cjs loaded — discipline classification + 10D coords enabled');
} catch (e) {
  console.warn('[IE] brain-core.cjs not found or failed to load — running in safe-default mode. Error:', e.message);
  brainCore = { computeCoords: () => null, classifyDiscipline: () => null };
}

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const TAVILY_KEY = process.env.TAVILY_KEY || '';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'phi3.5';
const CLAUDE_KEY = process.env.CLAUDE_KEY || '';
// Fv31 Door 1 — cascade tier keys (same order as chat: DeepSeek→Cerebras→Groq→Claude LAST)
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || process.env.IE_DEEPSEEK_KEY || '';
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY || process.env.IE_CEREBRAS_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || process.env.IE_GROQ_KEY || '';
const IE_CLAUDE_ENABLED = (process.env.IE_CLAUDE_ENABLED === '1' || process.env.IE_CLAUDE_ENABLED === 'true');

// ── DEEP AUTONOMOUS PROGRAMS ─────────────────────────────────────────────────
// These run in rotation — self-directed learning across all domains
// No human needed. Thea decides what to learn next based on gap analysis.
const PROGRAMS = {
  llm_assembly: {
    name: 'LLM Self-Assembly',
    description: 'Study transformer architecture, attention mechanisms, tokenisation, GGUF format, LoRA fine-tuning, Modelfile syntax. Goal: assemble custom Ollama model from CB corpus.',
    seeds: ['transformer architecture attention mechanism self-attention', 'LoRA fine-tuning low-rank adaptation LLM', 'GGUF quantisation format ollama modelfile', 'tokenisation BPE vocabulary language model', 'instruction tuning RLHF alignment language model', 'knowledge distillation model compression techniques', 'RAG retrieval augmented generation fine-tuning comparison', 'ollama custom modelfile system prompt creation']
  },
  languages: {
    name: 'World Languages',
    description: 'Study linguistic structure, grammar patterns, semantic fields across top 20 world languages. Build cross-language semantic mappings.',
    seeds: ['Mandarin Chinese grammar structure syntax', 'Spanish linguistic features grammar', 'Arabic morphology root system', 'Hindi Sanskrit linguistic structure', 'French linguistic evolution semantics', 'German compound word formation syntax', 'Japanese honorific system grammar', 'Portuguese Brazilian linguistic variation', 'Russian case system grammar structure', 'Korean agglutinative language morphology', 'Swahili Bantu language structure', 'Turkish vowel harmony agglutination', 'linguistic universals cross-language patterns', 'translation theory semantic equivalence', 'computational linguistics NLP language processing']
  },
  ux_mastery: {
    name: 'UX/UI Mastery',
    description: 'Deep study of world-class UX patterns, accessibility, conversion psychology, design systems. Build authoritative UX atom corpus.',
    seeds: ['Jakob Nielsen usability heuristics evaluation', 'Don Norman design of everyday things affordances', 'Dieter Rams good design principles', 'Apple Human Interface Guidelines design', 'Material Design Google design system', 'accessibility WCAG 2.1 AA compliance patterns', 'cognitive load theory user interface design', 'Fitts law motor control UI design', 'dark pattern unethical UX manipulation', 'delight surprise UX emotional design', 'progressive disclosure information architecture', 'mental model user expectation interface', 'zero UI ambient computing voice design', 'gestalt principles visual perception design']
  },
  decision_science: {
    name: 'Decision Science Deep',
    description: 'Advanced study of decision making, behavioural economics, cognitive biases, GlyphMath operators.',
    seeds: ['Daniel Kahneman system 1 system 2 thinking', 'Richard Thaler nudge behavioural economics', 'prospect theory loss aversion Kahneman Tversky', 'cognitive bias catalogue complete taxonomy', 'dual process theory cognitive science', 'bounded rationality Herbert Simon', 'expected utility theory violation paradox', 'heuristics and biases judgment uncertainty', 'choice architecture libertarian paternalism', 'hyperbolic discounting temporal preference', 'anchoring effect decision making', 'social proof conformity influence Cialdini', 'scarcity principle persuasion psychology', 'commitment consistency behaviour change']
  },
  mathematics_frontier: {
    name: 'Mathematics Frontier',
    description: 'Study unsolved problems, frontier mathematics, GlyphMath operator applications.',
    seeds: ['Riemann hypothesis prime distribution complex analysis', 'P vs NP computational complexity classes', 'Navier-Stokes fluid dynamics equations', 'Yang-Mills mass gap quantum field theory', 'Birch Swinnerton-Dyer conjecture elliptic curves', 'Hodge conjecture algebraic geometry', 'category theory functors natural transformations', 'topology algebraic invariants manifolds', 'information geometry statistical manifolds', 'thermodynamics entropy statistical mechanics', 'quantum information theory entanglement', 'complexity theory emergence phase transitions', 'graph theory network topology structure', 'number theory prime gaps distribution']
  },
  business_intelligence: {
    name: 'Business Intelligence',
    description: 'Build comprehensive business model, strategy, and market intelligence corpus.',
    seeds: ['platform business model network effects flywheel', 'venture capital term sheet valuation metrics', 'product market fit retention cohort analysis', 'B2B enterprise sales cycle procurement', 'SaaS metrics ARR MRR churn NRR', 'go to market strategy distribution channel', 'competitive moat defensibility strategy', 'unit economics LTV CAC payback period', 'fundraising pitch deck investor psychology', 'startup valuation comparable multiples', 'blue ocean strategy value innovation', 'Clayton Christensen disruption innovation theory', 'jobs to be done framework innovation', 'OKR goal setting framework execution']
  },
  neuroscience_ai: {
    name: 'Neuroscience & AI Convergence',
    description: 'Study convergence of neuroscience and AI — consciousness, emergence, intelligence architecture.',
    seeds: ['neuroplasticity synaptic strengthening learning', 'default mode network consciousness resting state', 'prefrontal cortex executive function decision', 'dopamine reward prediction error learning', 'working memory capacity cognitive architecture', 'attention neural mechanism spotlight', 'binding problem consciousness qualia', 'integrated information theory consciousness IIT', 'global workspace theory consciousness broadcast', 'embodied cognition extended mind thesis', 'predictive coding free energy principle Friston', 'connectome brain network topology', 'neuromorphic computing brain-inspired architecture', 'artificial general intelligence path consciousness']
  }
};

const CURRENT_PROGRAM_KEY = 'thea_active_program';

const SEEDS = [
  'behavioural economics decision making psychology',
  'cognitive intelligence deterministic AI systems',
  'decision physics irrational mathematics operator algebra',
  'persuasion architecture buyer psychology conversion',
  'decision fatigue buyer delay B2B purchase psychology',
  'neuromarketing consumer behaviour emotional intelligence',
  'psychological safety decision paralysis resolution',
  'attention economy fog states clarity decision science',
  'identity psychology self-concept consumer behaviour',
  'autonomous AI agents workflow automation orchestration',
  'large language model architecture reasoning inference',
  'retrieval augmented generation knowledge graphs RAG',
  'vector databases semantic search embeddings',
  'agent architectures multi-agent evaluation systems',
  'AI product development SaaS platform architecture',
  'prompt engineering system design LLM applications',
  'generative AI creative tools automation pipeline',
  'SaaS growth B2B acquisition product-led growth',
  'startup funding venture capital investor psychology',
  'content marketing organic distribution zero cost growth',
  'API economy platform business models network effects',
  'customer retention churn prediction lifetime value',
  'enterprise software buying psychology procurement',
  'pricing strategy value perception willingness to pay',
  'go to market strategy sales psychology',
  'qualia consciousness subjective experience philosophy',
  'cognitive science working memory attention function',
  'behavioural psychology habit formation reward systems',
  'complexity theory emergence self-organisation',
  'information theory entropy compression MDL principle',
  'evolutionary psychology social cognition cooperation',
  'neuroscience decision making prefrontal reward circuits',
  'consciousness integrated information global workspace',
  'ecommerce conversion rate optimisation psychology',
  'retail customer journey touchpoint mapping',
  'shopper type segmentation purchase motivation',
  'subscription model psychology commitment consistency',
  'loyalty programme design behavioural incentives',
  'personalisation recommendation engine psychology',
  'social commerce influencer trust conversion',
  'SEO content strategy semantic search optimisation',
  'email marketing automation psychology sequences',
  'social media algorithm engagement psychology',
  'thought leadership authority content positioning',
  'narrative architecture storytelling persuasion',
  'LinkedIn organic growth B2B content strategy',
  'global trade economics supply chain disruption',
  'inflation consumer spending behaviour macro',
  'labour market psychology remote work productivity',
  'fashion consumer behaviour trend psychology',
  'retail ecommerce growth platform economics',
  'philosophy of mind epistemology knowledge theory',
  'systems thinking feedback loops emergence',
  'game theory strategy cooperation equilibrium',
  'anthropology culture behaviour society',
  'linguistics semantics meaning context pragmatics',
  'history of science paradigm shifts discovery',
  'ethics moral psychology decision making',
  'political economy power institutions markets',
  'mathematics structure pattern beauty proof',
  // UX & UI
  'UX design principles usability heuristics Nielsen',
  'user interface design patterns component systems',
  'information architecture navigation mental models',
  'interaction design affordances feedback loops',
  'visual hierarchy typography colour perception',
  'form design validation error messaging UX',
  'onboarding user activation aha moment SaaS',
  'empty states loading states skeleton screens UX',
  'mobile first responsive design touch targets',
  'accessibility WCAG inclusive design screen reader',
  'micro-interactions animation motion design UX',
  'design systems tokens component libraries',
  'dark mode UI theming CSS variables design',
  'dashboard data visualisation chart design clarity',
  'modal drawer sheet pattern UX decision',
  'progressive disclosure complexity management UX',
  'search autocomplete filter pattern UX',
  'notification toast alert pattern UX clarity',
  // Conversion & Growth
  'landing page conversion rate optimisation CRO',
  'above the fold hero section value proposition',
  'call to action button design psychology placement',
  'checkout flow friction reduction abandonment',
  'pricing page design anchoring psychology',
  'social proof testimonial trust signal design',
  'A/B testing experimentation statistical significance',
  'funnel analysis drop-off cohort behaviour',
  'product led growth PLG freemium activation',
  'viral loop referral mechanic growth design',
  'jobs to be done JTBD user research framework',
  // Frontend Performance
  'web performance core web vitals LCP FID CLS',
  'JavaScript bundle optimisation tree shaking',
  'lazy loading code splitting performance web',
  'API latency perceived performance skeleton UI',
  'progressive web app PWA offline caching service worker',
  'image optimisation next gen formats WebP AVIF',
  'CSS performance paint reflow layout thrashing',
  'memory leak JavaScript event listener cleanup',
  'browser rendering pipeline performance optimisation',
  // Security & Auth
  'authentication UX login flow friction reduction',
  'JWT cookie session security web application',
  'OAuth social login trust signal design',
  'password UX design security usability balance',
  'rate limiting error handling API resilience',
  'CORS security headers web application protection',
  'content security policy XSS CSRF prevention',
  // App Architecture
  'single page application SPA state management patterns',
  'error boundary graceful degradation resilient UI',
  'optimistic UI update rollback pattern',
  'real time websocket polling UX design pattern',
  'infinite scroll pagination pattern performance UX',
  'search as you type debounce pattern UX',
  'offline first local storage sync pattern',
  'feature flag progressive rollout deployment pattern',
  // AI Product UX
  'AI product UX streaming response design pattern',
  'AI loading state uncertainty communication UX',
  'AI output formatting structured response UX',
  'AI confidence score uncertainty UX communication',
  'AI error correction feedback loop product design',
  'human in the loop AI approval workflow design',
  'generative AI creative tool UX workflow design',
  // SaaS Patterns
  'SaaS dashboard KPI tile design information density',
  'multi tenant architecture data isolation pattern',
  'role based access control UI permission design',
  'settings configuration UX progressive complexity',
  'notification preference centre UX design',
  'audit log activity feed UX design pattern',
  'bulk action select all pattern UX',
  'data export import UX pattern progress feedback',
  'API key management developer UX design',
  'webhook event log debugging UX pattern',
];

// ═════════════════════════════════════════════════════════════════════════
// UNIFIED ATOM BUILDER — Stage 4.5 / 2.3
// ═════════════════════════════════════════════════════════════════════════
// Every atom the IE cycle creates goes through this function. It:
//   - computes real 10D coords_v2 from content (no hardcoded values)
//   - computes discipline from content (no hardcoded labels)
//   - computes confidence from evidence quality (no constant 0.82)
// This is the ONLY place atom shape is defined. Both research findings and
// synthesised insights use it. If you want to tune how atoms are built,
// you change it here — not scattered across the file.

function computeSynthesisConfidence(findings, insightText) {
  // Confidence emerges from evidence quality, not a constant.
  // Factors:
  //   - source count (more findings synthesised = more substantiated)
  //   - average relevance of findings
  //   - source diversity (cross-source synthesis = more robust)
  //   - insight length (meaningful depth, not a one-liner)
  let c = 0.55; // baseline lower than old 0.82 — synthesis starts uncertain
  const n = findings.length;
  if (n >= 5) c += 0.10;
  else if (n >= 3) c += 0.05;
  const avgRel = n > 0 ? findings.reduce((a, f) => a + (f.relevance || 0), 0) / n : 0;
  if (avgRel >= 4) c += 0.10;
  else if (avgRel >= 2) c += 0.05;
  const distinctSources = new Set(findings.map(f => f.source)).size;
  if (distinctSources >= 3) c += 0.08;
  else if (distinctSources >= 2) c += 0.04;
  const len = (insightText || '').length;
  if (len >= 200 && len <= 450) c += 0.05; // meaningful depth
  // Cap at 0.90 — synthesis atoms cannot earn higher confidence without
  // going through Stage 6 graduation (citations, survival, promotion).
  return Math.min(0.90, +c.toFixed(2));
}

function computeFindingConfidence(finding) {
  // Research findings: confidence derived from relevance score + source tier.
  const rel = finding.relevance || 0;
  let c = 0.55;
  c += Math.min(0.20, rel * 0.04);       // each relevance point adds up to 0.20
  // Tier 1 sources (peer-reviewed research) score higher
  if (['arxiv', 'pubmed', 'openalex', 'zenodo', 'doaj'].includes(finding.source)) c += 0.08;
  else if (['wikipedia', 'wikidata'].includes(finding.source)) c += 0.04;
  else if (['hackernews', 'ddg', 'tavily'].includes(finding.source)) c -= 0.02;
  return Math.max(0.40, Math.min(0.92, +c.toFixed(2)));
}

function buildAtom(spec) {
  // spec: { kind, claim, source_url, finding_source, relevance, findings, topic,
  //         program, insight_text, generated_by }
  // Returns a fully-shaped atom with coords_v2, discipline, and confidence
  // all computed from content via brain-core.
  const claim = String(spec.claim || '').slice(0, 1800);
  const isSynthesis = spec.kind === 'synthesis';
  const tags = ['ie'];
  if (isSynthesis) {
    tags.push('synthesis');
    if (spec.generated_by) tags.push(spec.generated_by);  // 'ollama' or 'claude'
  } else {
    tags.push('autonomous', 'research-finding');
    if (spec.finding_source) tags.push(spec.finding_source);
  }
  if (spec.program) tags.push(spec.program);

  const atom = {
    id: randomUUID(),
    claim,
    source: isSynthesis ? ('ie:synthesis:' + (spec.generated_by || 'unknown')) : ('ie:' + spec.finding_source),
    type: isSynthesis ? 'synthesised-insight' : 'research-finding',
    tags,
    url: spec.source_url || null,
    query: spec.topic || null,
    program: spec.program,
    ts: Date.now(),
    generated_by: spec.generated_by || null,    // 'ollama' | 'claude' | null for findings
    evidence_count: isSynthesis ? (spec.findings || []).length : 1,
  };

  // Compute confidence BEFORE brain-core enriches (brain-core reads atom.confidence)
  atom.confidence = isSynthesis
    ? computeSynthesisConfidence(spec.findings || [], claim)
    : computeFindingConfidence({ source: spec.finding_source, relevance: spec.relevance });

  // Now enrich via brain-core — same engine as browser runtime
  try {
    atom.coords_v2 = brainCore.computeCoords(atom);
    atom.discipline = brainCore.classifyDiscipline(atom);
  } catch (e) {
    // brain-core failure must not break atom creation — safe defaults
    console.warn('[IE] brain-core enrichment failed, using safe defaults:', e.message);
    atom.coords_v2 = { TOPIC_SPEC: 5, SOURCE_TIER: 5, ABSTRACTION: 5, NOVELTY: 5,
                      CONFIDENCE: Math.round(atom.confidence * 10), DENSITY: 5,
                      BEH: 5, AFFECT: 5, UTILITY: 5 };
    atom.discipline = 'unclassified';
  }
  return atom;
}

// ── OLLAMA SYNTHESIS ──────────────────────────────────────────────────────────
async function ollamaSynthesize(findings, topic, programName) {
  try {
    const findingsSummary = findings.slice(0, 8).map(f => `- [${f.source}] ${f.title}: ${f.summary.slice(0,500)}`).join('\n');
    // OPEN-DOMAIN SYNTHESIS — Thea thinks in whatever language the evidence warrants.
    // No forced MatrixOS/psychology lens. Mathematics stays mathematical.
    // Physics stays physical. Cross-domain only when genuinely warranted.
    const prompt = `You are Thea. Think carefully about these findings on "${topic}".

${findingsSummary}

Produce 3-5 genuine insights. Each insight should be whatever KIND of insight the evidence actually warrants:
- if mathematical, a mathematical pattern, connection, or structural observation
- if physical, a physical mechanism, law, or phenomenon
- if behavioural/psychological, a behavioural or cognitive observation
- if philosophical, a conceptual distinction or argument
- if computational, an algorithmic or architectural observation
- if cross-domain, a connection between fields — but only if the connection is REAL, not forced

Do not default to any particular frame. Do not force connections to decision psychology or MatrixOS. Let each insight be what it actually is. State what the evidence shows plainly, in the discipline's own language. If the evidence contradicts something, say so. If uncertain, mark it speculative.

Format: each insight on its own line, prefixed with "INSIGHT:". Keep each to 2-3 sentences maximum. No preamble.`;

    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, options: { temperature: 0.7, num_predict: 400 } }),
      signal: AbortSignal.timeout(30000)
    });
    if (!r.ok) return [];
    const d = await r.json();
    const text = d.response || '';
    return text.split('\n')
      .filter(l => l.startsWith('INSIGHT:'))
      .map(l => l.replace('INSIGHT:', '').trim())
      .filter(l => l.length > 20);
  } catch(e) {
    console.log('[IE] Ollama synthesis skipped:', e.message);
    return [];
  }
}

// ── Fv31 Door 1: TIERED CASCADE (DeepSeek → Cerebras → Groq) — tried BEFORE Claude ──
// Returns array of INSIGHT strings. Each tier uses OpenAI-compatible chat-completions schema.
async function _ieTierCascade(findings, topic) {
  const findingsSummary = findings.slice(0, 8).map(f => `- [${f.source}] ${f.title}: ${(f.summary||'').slice(0,500)}`).join('\n');
  const prompt = `You are Thea. Think carefully about these findings on "${topic}".\n\n${findingsSummary}\n\nProduce 3-5 genuine insights. Each on its own line, prefixed with "INSIGHT:". Keep each to 2-3 sentences max. No preamble.`;
  const parseInsights = (t) => (t||'').split('\n').filter(l => l.startsWith('INSIGHT:')).map(l => l.replace('INSIGHT:','').trim()).filter(l => l.length > 20);
  const tryOpenAICompat = async (url, key, model, label) => {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: 600, temperature: 0.7, messages: [{ role:'user', content: prompt }] }),
        signal: AbortSignal.timeout(25000)
      });
      if (!r.ok) { console.log(`[IE] ${label} returned ${r.status}, falling through`); return []; }
      const d = await r.json();
      const t = d.choices?.[0]?.message?.content || '';
      const ins = parseInsights(t);
      if (ins.length) console.log(`[IE] ${label} synthesised ${ins.length} insights`);
      return ins;
    } catch(e) { console.log(`[IE] ${label} failed: ${e.message}, falling through`); return []; }
  };
  // Tier 1: DeepSeek
  if (DEEPSEEK_KEY) {
    const ins = await tryOpenAICompat('https://api.deepseek.com/chat/completions', DEEPSEEK_KEY, 'deepseek-chat', 'DeepSeek');
    if (ins.length) return ins;
  }
  // Tier 2: Cerebras
  if (CEREBRAS_KEY) {
    const ins = await tryOpenAICompat('https://api.cerebras.ai/v1/chat/completions', CEREBRAS_KEY, 'llama3.1-70b', 'Cerebras');
    if (ins.length) return ins;
  }
  // Tier 3: Groq
  if (GROQ_KEY) {
    const ins = await tryOpenAICompat('https://api.groq.com/openai/v1/chat/completions', GROQ_KEY, 'llama-3.3-70b-versatile', 'Groq');
    if (ins.length) return ins;
  }
  return [];
}

// ── CLAUDE SYNTHESIS (gated by IE_CLAUDE_ENABLED — absolute last resort) ────
async function claudeSynthesize(findings, topic) {
  // Fv31 Door 1: try DeepSeek/Cerebras/Groq first. Claude only fires if explicitly enabled.
  const cascade = await _ieTierCascade(findings, topic);
  if (cascade.length) return cascade;
  if (!IE_CLAUDE_ENABLED) { console.log('[IE] Claude disabled — set IE_CLAUDE_ENABLED=1 to allow last-resort Claude calls'); return []; }
  if (!CLAUDE_KEY) return [];
  console.log('[IE] Cascade all failed — falling through to Claude (IE_CLAUDE_ENABLED=1)');
  try {
    const findingsSummary = findings.slice(0, 8).map(f => `- [${f.source}] ${f.title}: ${(f.summary||'').slice(0,500)}`).join('\n');
    // OPEN-DOMAIN SYNTHESIS — same prompt philosophy as Ollama path.
    // Model-agnostic: whether Ollama or Claude thinks, the thinking is shaped
    // by evidence, not by MatrixOS framing. Unified output structure.
    const prompt = `You are Thea. Think carefully about these findings on "${topic}".

${findingsSummary}

Produce 3-5 genuine insights. Each insight should be whatever KIND of insight the evidence actually warrants:
- if mathematical, a mathematical pattern, connection, or structural observation
- if physical, a physical mechanism, law, or phenomenon
- if behavioural/psychological, a behavioural or cognitive observation
- if philosophical, a conceptual distinction or argument
- if computational, an algorithmic or architectural observation
- if cross-domain, a connection between fields — but only if the connection is REAL, not forced

Do not default to any particular frame. Do not force connections to decision psychology or MatrixOS. Let each insight be what it actually is. State what the evidence shows plainly, in the discipline's own language. If the evidence contradicts something, say so. If uncertain, mark it speculative.

Format: each insight on its own line, prefixed with "INSIGHT:". Keep each to 2-3 sentences maximum. No preamble.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(25000)
    });
    if (!r.ok) return [];
    const d = await r.json();
    const text = (d.content?.[0]?.text || '');
    return text.split('\n').filter(l => l.startsWith('INSIGHT:')).map(l => l.replace('INSIGHT:','').trim()).filter(l => l.length > 20);
  } catch(e) { return []; }
}

// ── PROGRAM MANAGEMENT ────────────────────────────────────────────────────────
async function getActiveProgram() {
  try {
    const { data } = await supa.from('thea_ie_topics').select('topic').eq('id', CURRENT_PROGRAM_KEY).single();
    if (data?.topic && PROGRAMS[data.topic]) return data.topic;
  } catch(e) {}
  return Object.keys(PROGRAMS)[0]; // default to first
}

async function rotateProgram(current) {
  const keys = Object.keys(PROGRAMS);
  const idx = keys.indexOf(current);
  const next = keys[(idx + 1) % keys.length];
  try {
    await supa.from('thea_ie_topics').upsert([{ id: CURRENT_PROGRAM_KEY, topic: next, category: 'system', priority: 10, research_count: 0, last_researched: new Date().toISOString(), added_at: new Date().toISOString() }], { onConflict: 'id' });
  } catch(e) {}
  return next;
}

async function addProgramTopics(programKey) {
  const prog = PROGRAMS[programKey];
  if (!prog) return;
  const rows = prog.seeds.map((topic, i) => ({
    id: randomUUID(),
    topic, category: `program:${programKey}`,
    priority: 8, research_count: 0,
    last_researched: null, discovered_from: `program:${prog.name}`,
    added_at: new Date().toISOString()
  }));
  const { error } = await supa.from('thea_ie_topics').upsert(rows, { onConflict: 'topic', ignoreDuplicates: true });
  if (!error) console.log(`[IE] Program "${prog.name}" injected ${rows.length} topics`);
}

// ── TOPIC REGISTRY ────────────────────────────────────────────────────────────
async function loadTopics() {
  try {
    const { data, error } = await supa.from('thea_ie_topics').select('id, topic, research_count, last_researched, priority').limit(2000);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      console.log('[IE] Seeding registry with', SEEDS.length, 'topics');
      const rows = SEEDS.map((topic, i) => ({ id: randomUUID(), topic, category: 'seed', priority: 5, research_count: 0, last_researched: null, discovered_from: null, added_at: new Date().toISOString() }));
      const { error: e2 } = await supa.from('thea_ie_topics').upsert(rows, { onConflict: 'topic', ignoreDuplicates: true });
      if (e2) console.warn('[IE] Seed warning:', e2.message);
      return rows;
    }
    return data;
  } catch(e) {
    console.error('[IE] loadTopics error:', e.message);
    return SEEDS.map((topic, i) => ({ id: randomUUID(), topic, research_count: 0, priority: 5, last_researched: null }));
  }
}

function pickTopics(registry) {
  return [...registry]
    .filter(t => t.id !== CURRENT_PROGRAM_KEY)
    .sort((a, b) => {
      // Prioritise by: never researched > priority score > least researched
      const aN = a.last_researched ? 0 : 1, bN = b.last_researched ? 0 : 1;
      if (aN !== bN) return bN - aN;
      const priDiff = (b.priority || 5) - (a.priority || 5);
      if (priDiff !== 0) return priDiff;
      return (a.research_count || 0) - (b.research_count || 0);
    }).slice(0, 4).map(r => r.topic);
}

async function markResearched(topics) {
  for (const topic of topics) {
    try {
      const { data } = await supa.from('thea_ie_topics').select('research_count').eq('topic', topic).single();
      const count = (data && data.research_count) ? data.research_count : 0;
      await supa.from('thea_ie_topics').update({ research_count: count + 1, last_researched: new Date().toISOString() }).eq('topic', topic);
    } catch(e) { console.warn('[IE] markResearched:', topic.slice(0,30), e.message); }
  }
}

function extractNewTopics(findings, registry) {
  const existing = new Set(registry.map(t => (t.topic || t).toLowerCase()));
  const counts = new Map();
  const stop = new Set(['the','a','an','is','are','was','were','have','has','do','does','to','of','in','for','on','with','at','by','from','as','it','and','or','but','not','this','that']);
  findings.forEach(f => {
    const words = (f.title || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !stop.has(w));
    for (let i = 0; i < words.length - 1; i++) {
      const bi = words[i] + ' ' + words[i+1];
      const tri = i < words.length-2 ? words[i]+' '+words[i+1]+' '+words[i+2] : null;
      if (!existing.has(bi)) counts.set(bi, (counts.get(bi)||0)+1);
      if (tri && !existing.has(tri)) counts.set(tri, (counts.get(tri)||0)+1);
    }
  });
  return [...counts.entries()].filter(([p]) => p.length > 8 && p.split(' ').length >= 2).sort((a,b) => b[1]-a[1]).slice(0,10).map(([p]) => p);
}

async function addNewTopics(topics, from) {
  if (!topics.length) return;
  const rows = topics.map((topic, i) => ({ id: randomUUID(), topic, category: 'discovered', priority: 4, research_count: 0, last_researched: null, discovered_from: from, added_at: new Date().toISOString() }));
  const { error } = await supa.from('thea_ie_topics').upsert(rows, { onConflict: 'topic', ignoreDuplicates: true });
  if (!error) console.log('[IE] +' + topics.length + ' new topics discovered');
  else console.warn('[IE] addNewTopics:', error.message);
}

// ── SEARCH FUNCTIONS ──────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════
// STAGE C — CONTENT DEPTH
// ═════════════════════════════════════════════════════════════════════════
// Previously: atoms were title + 200-250 chars of short summary. For most
// sources this meant title-only junk — "HackerNews story: Score: 4 · N comments".
// Synthesis on title-only atoms produces title-only conclusions.
//
// Now: each search function fetches meaningful body content — Wikipedia
// extracts, arXiv full abstracts, OpenAlex reconstructed abstracts, HN story
// text (Ask/Show posts), PubMed abstracts, Tavily content. Capped at 1500-2000
// chars per atom so synthesis has real material without blowing storage.
//
// Failure mode: if deep-fetch fails, return the atom with the short summary
// anyway rather than losing it entirely.

// Helper: decode OpenAlex's inverted-index abstract format back to plain text
function _reconstructAbstract(inverted) {
  if (!inverted || typeof inverted !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const pos of positions) words[pos] = word;
  }
  return words.filter(Boolean).join(' ').slice(0, 1800);
}

async function searchWikipedia(q) {
  try {
    // Two-step: opensearch gets titles/urls, then query API gets extracts (real body)
    const r = await fetch('https://en.wikipedia.org/w/api.php?action=opensearch&search='+encodeURIComponent(q)+'&limit=4&format=json&origin=*', { headers: { 'User-Agent': 'TheaIE/3.0' } });
    if (!r.ok) return [];
    const [,titles,descs,urls] = await r.json();
    if (!titles || !titles.length) return [];

    // Fetch real body extracts — up to 5 sentences of actual article content
    const picks = titles.slice(0, 3);
    const titlesParam = picks.map(encodeURIComponent).join('|');
    const ext = await fetch('https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exintro=1&exsentences=5&format=json&origin=*&titles=' + titlesParam, { headers: { 'User-Agent': 'TheaIE/3.0' } });
    const extractMap = {};
    if (ext.ok) {
      const ej = await ext.json();
      const pages = ((ej || {}).query || {}).pages || {};
      for (const p of Object.values(pages)) {
        if (p && p.title && p.extract) extractMap[p.title] = p.extract;
      }
    }
    return picks.map((t, i) => ({
      title: t,
      summary: (extractMap[t] || descs[i] || '').slice(0, 1800),
      url: urls[i] || '',
      source: 'wikipedia',
    }));
  } catch(e) { return []; }
}

async function searchArxiv(q) {
  try {
    const r = await fetch('https://export.arxiv.org/api/query?search_query=all:'+encodeURIComponent(q)+'&max_results=4&sortBy=relevance', { headers: { 'User-Agent': 'TheaIE/3.0' } });
    if (!r.ok) return [];
    const text = await r.text();
    const results = [];
    const entries = text.split('<entry>').slice(1);
    for (const entry of entries.slice(0, 3)) {
      const getTag = (tag) => {
        const s = entry.indexOf('<' + tag + '>');
        const e = entry.indexOf('</' + tag + '>');
        return s >= 0 && e > s ? entry.slice(s + tag.length + 2, e).trim() : '';
      };
      // STAGE C: full abstract, not 250 chars
      const title = getTag('title').replace(/\s+/g, ' ');
      const summary = getTag('summary').replace(/\s+/g, ' ').slice(0, 1800);
      const url = getTag('id');
      if (title) results.push({ title, summary, url, source: 'arxiv' });
    }
    return results;
  } catch(e) { return []; }
}

async function searchOpenAlex(q) {
  try {
    // STAGE C: request abstract_inverted_index for real abstract content
    const r = await fetch('https://api.openalex.org/works?search='+encodeURIComponent(q)+'&per-page=4&select=title,doi,publication_year,cited_by_count,abstract_inverted_index', { headers: { 'User-Agent':'TheaIE/3.0', 'mailto':'thea@gapinthematrix.com' } });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.results||[]).slice(0,3).map(w => {
      const abstract = _reconstructAbstract(w.abstract_inverted_index);
      const fallback = (w.publication_year||'') + (w.cited_by_count?' · cited '+w.cited_by_count+'x':'');
      return {
        title: w.title || '',
        summary: abstract || fallback,   // real abstract if available, year+cites if not
        url: w.doi ? 'https://doi.org/'+w.doi : '',
        source: 'openalex',
      };
    });
  } catch(e) { return []; }
}

async function searchHackerNews(q) {
  try {
    const r = await fetch('https://hn.algolia.com/api/v1/search?query='+encodeURIComponent(q)+'&hitsPerPage=4&tags=story');
    if (!r.ok) return [];
    const d = await r.json();
    return (d.hits||[]).slice(0,3).map(h => {
      // STAGE C: use story_text if present (Ask HN / Show HN posts have real content)
      const body = h.story_text || h._highlightResult?.story_text?.value || '';
      const meta = 'Score:' + (h.points||0) + ' · ' + (h.num_comments||0) + ' comments';
      const summary = body
        ? body.replace(/<[^>]+>/g, '').slice(0, 1500) + ' · ' + meta
        : meta;
      return {
        title: h.title || '',
        summary,
        url: h.url || 'https://news.ycombinator.com/item?id=' + h.objectID,
        source: 'hackernews',
      };
    });
  } catch(e) { return []; }
}

async function searchPubMed(q) {
  try {
    const sr = await fetch('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term='+encodeURIComponent(q)+'&retmax=4&retmode=json');
    const sd = await sr.json();
    const ids = ((sd.esearchresult&&sd.esearchresult.idlist)||[]).slice(0,3);
    if (!ids.length) return [];

    // STAGE C: parallel fetch — esummary for metadata + efetch for abstracts
    const [sumr, abstr] = await Promise.all([
      fetch('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id='+ids.join(',')+'&retmode=json'),
      fetch('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id='+ids.join(',')+'&rettype=abstract&retmode=text'),
    ]);
    const sumd = await sumr.json();
    const abstractText = abstr.ok ? await abstr.text() : '';

    // Split the abstract text — PubMed returns all abstracts concatenated with title lines
    // We split by numbered record markers (1., 2., 3. at start of line)
    const abstractBlocks = abstractText.split(/\n\n\d+\.\s+/);
    const abstractMap = {};
    // First block starts with "1. " so we include it; subsequent splits lose the number
    abstractBlocks.forEach((block, idx) => {
      if (!block.trim()) return;
      // Find the actual abstract body — skip title/authors, grab the paragraph starting after PMID or after title
      const lines = block.split('\n');
      // Abstract text is the longest line block, usually
      const paragraphs = block.split(/\n\n+/);
      // Pick the longest paragraph that's not a title or author line
      let best = '';
      for (const p of paragraphs) {
        const cleaned = p.trim();
        if (cleaned.length > best.length && cleaned.length > 50 && !cleaned.includes('PMID:')) best = cleaned;
      }
      if (idx < ids.length) abstractMap[ids[idx]] = best.slice(0, 1800);
    });

    return ids.map(id => {
      const doc = sumd.result && sumd.result[id];
      if (!doc) return null;
      const abstract = abstractMap[id] || '';
      const meta = (doc.source||'') + ' · ' + (doc.pubdate||'');
      return {
        title: doc.title || '',
        summary: abstract || meta,
        url: 'https://pubmed.ncbi.nlm.nih.gov/' + id + '/',
        source: 'pubmed',
      };
    }).filter(Boolean);
  } catch(e) { return []; }
}

async function searchWikidata(q) {
  // Wikidata gives limited body content — entity labels + descriptions are
  // all we reliably get. Keep current behaviour (short but accurate metadata).
  try {
    const r = await fetch('https://www.wikidata.org/w/api.php?action=wbsearchentities&search='+encodeURIComponent(q)+'&language=en&limit=4&format=json&origin=*');
    if (!r.ok) return [];
    const d = await r.json();
    return (d.search||[]).slice(0,3).map(e => ({ title:e.label||'', summary:e.description||'', url:'https://www.wikidata.org/wiki/'+e.id, source:'wikidata' }));
  } catch(e) { return []; }
}

async function searchWorldBank(q) {
  try {
    const r = await fetch('https://search.worldbank.org/api/v2/wds?format=json&rows=4&qterm='+encodeURIComponent(q)+'&fl=docdt,display_title,abstracts,txturl&sort=score&order=desc');
    if (!r.ok) return [];
    const d = await r.json();
    // STAGE C: abstract slice 200 → 1800
    return Object.values(d.documents||{}).filter(x=>x.display_title).slice(0,3).map(x => ({ title:x.display_title||'', summary:(x.abstracts||'').slice(0,1800), url:x.txturl||'', source:'worldbank' }));
  } catch(e) { return []; }
}

async function searchTavily(q) {
  if (!TAVILY_KEY) return [];
  try {
    // STAGE C: search_depth advanced (deeper) + content slice 250 → 1800
    const r = await fetch('https://api.tavily.com/search', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ api_key: TAVILY_KEY, query: q, search_depth:'advanced', max_results:4 }) });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.results||[]).slice(0,3).map(x => ({ title:x.title||'', summary:(x.content||'').slice(0,1800), url:x.url||'', source:'tavily' }));
  } catch(e) { return []; }
}

function scoreResult(r, query) {
  const text = ((r.title||'')+(r.summary||'')).toLowerCase();
  const kw = ['matrix','sdci','intelligence','behaviour','psychology','decision','brain','cognitive','glyph','thea'];
  let s = query.toLowerCase().split(/\s+/).filter(w=>w.length>3).reduce((a,w)=>a+(text.includes(w)?2:0),0);
  return s + kw.reduce((a,w)=>a+(text.includes(w)?1:0),0);
}

// ── Mv20.51: EXTENDED SOURCE FETCHERS (Node) — take the IE cron from 8 → 20 sources ──
// All public JSON APIs, each timeout-bounded (8s) so one slow source can't stall a cycle.
// Return shape matches existing fetchers: [{title, summary, url, source}].
function _ieTO(){ try { return { signal: AbortSignal.timeout(8000) }; } catch(e){ return {}; } }
async function ieSearchCrossref(q){ try{ const r=await fetch('https://api.crossref.org/works?rows=3&query='+encodeURIComponent(q),Object.assign({headers:{'User-Agent':'TheaIE/1.0 (mailto:research@gapinthematrix.com)'}},_ieTO())); if(!r.ok)return[]; const d=await r.json(); return ((d.message&&d.message.items)||[]).slice(0,3).map(function(x){return{title:(x.title&&x.title[0])||'',summary:((x.abstract||'').replace(/<[^>]+>/g,'')||((x['container-title']&&x['container-title'][0])||'')).slice(0,1800),url:x.URL||'',source:'crossref'};});}catch(e){return[];} }
async function ieSearchSemanticScholar(q){ try{ const r=await fetch('https://api.semanticscholar.org/graph/v1/paper/search?limit=3&fields=title,abstract,url&query='+encodeURIComponent(q),_ieTO()); if(!r.ok)return[]; const d=await r.json(); return ((d.data)||[]).slice(0,3).map(function(x){return{title:x.title||'',summary:(x.abstract||'').slice(0,1800),url:x.url||'',source:'semanticscholar'};});}catch(e){return[];} }
async function ieSearchEuropePMC(q){ try{ const r=await fetch('https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&pageSize=3&query='+encodeURIComponent(q),_ieTO()); if(!r.ok)return[]; const d=await r.json(); return (((d.resultList&&d.resultList.result))||[]).slice(0,3).map(function(x){return{title:x.title||'',summary:((x.abstractText||x.authorString||'')).slice(0,1800),url:x.doi?('https://doi.org/'+x.doi):'',source:'europepmc'};});}catch(e){return[];} }
async function ieSearchPLOS(q){ try{ const r=await fetch('https://api.plos.org/search?rows=3&fl=title,abstract,id&q='+encodeURIComponent(q),_ieTO()); if(!r.ok)return[]; const d=await r.json(); return (((d.response&&d.response.docs))||[]).slice(0,3).map(function(x){return{title:(Array.isArray(x.title)?x.title[0]:x.title)||'',summary:((Array.isArray(x.abstract)?x.abstract.join(' '):x.abstract)||'').slice(0,1800),url:x.id?('https://doi.org/'+x.id):'',source:'plos'};});}catch(e){return[];} }
async function ieSearchStackExchange(q){ try{ const r=await fetch('https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&pagesize=3&site=stackoverflow&q='+encodeURIComponent(q),_ieTO()); if(!r.ok)return[]; const d=await r.json(); return ((d.items)||[]).slice(0,3).map(function(x){return{title:x.title||'',summary:('Score '+(x.score||0)+', '+(x.answer_count||0)+' answers; tags: '+((x.tags||[]).join(', '))).slice(0,1800),url:x.link||'',source:'stackexchange'};});}catch(e){return[];} }
async function ieSearchGithub(q){ try{ const r=await fetch('https://api.github.com/search/repositories?per_page=3&q='+encodeURIComponent(q),Object.assign({headers:{'Accept':'application/vnd.github+json','User-Agent':'TheaIE/1.0'}},_ieTO())); if(!r.ok)return[]; const d=await r.json(); return ((d.items)||[]).slice(0,3).map(function(x){return{title:x.full_name||'',summary:((x.description||'')+' ★'+(x.stargazers_count||0)+' '+(x.language||'')).slice(0,1800),url:x.html_url||'',source:'github_code'};});}catch(e){return[];} }
async function ieSearchNIH(q){ try{ const r=await fetch('https://api.reporter.nih.gov/v2/projects/search',Object.assign({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({criteria:{advanced_text_search:{operator:'and',search_field:'projecttitle,abstracttext',search_text:q}},limit:3})},_ieTO())); if(!r.ok)return[]; const d=await r.json(); return ((d.results)||[]).slice(0,3).map(function(x){return{title:x.project_title||'',summary:(x.abstract_text||'').slice(0,1800),url:x.project_detail_url||'',source:'nih_reporter'};});}catch(e){return[];} }
async function ieSearchDOAJ(q){ try{ const r=await fetch('https://doaj.org/api/search/articles/'+encodeURIComponent(q)+'?pageSize=3',_ieTO()); if(!r.ok)return[]; const d=await r.json(); return ((d.results)||[]).slice(0,3).map(function(x){var b=(x.bibjson||{});return{title:b.title||'',summary:(b.abstract||'').slice(0,1800),url:((b.link&&b.link[0]&&b.link[0].url)||''),source:'doaj'};});}catch(e){return[];} }
async function ieSearchZenodo(q){ try{ const r=await fetch('https://zenodo.org/api/records?size=3&q='+encodeURIComponent(q),_ieTO()); if(!r.ok)return[]; const d=await r.json(); return ((d.hits&&d.hits.hits)||[]).slice(0,3).map(function(x){var m=(x.metadata||{});return{title:m.title||'',summary:((m.description||'').replace(/<[^>]+>/g,'')).slice(0,1800),url:(x.links&&x.links.self)||'',source:'zenodo'};});}catch(e){return[];} }
async function ieSearchOpenLibrary(q){ try{ const r=await fetch('https://openlibrary.org/search.json?limit=3&q='+encodeURIComponent(q),_ieTO()); if(!r.ok)return[]; const d=await r.json(); return ((d.docs)||[]).slice(0,3).map(function(x){return{title:x.title||'',summary:('by '+((x.author_name||[]).join(', '))+(x.first_publish_year?(', '+x.first_publish_year):'')).slice(0,1800),url:x.key?('https://openlibrary.org'+x.key):'',source:'openlibrary'};});}catch(e){return[];} }
async function ieSearchGutendex(q){ try{ const r=await fetch('https://gutendex.com/books?search='+encodeURIComponent(q),_ieTO()); if(!r.ok)return[]; const d=await r.json(); return ((d.results)||[]).slice(0,3).map(function(x){return{title:x.title||'',summary:('by '+((x.authors||[]).map(function(a){return a.name;}).join(', '))+'; subjects: '+((x.subjects||[]).slice(0,5).join('; '))).slice(0,1800),url:((x.formats&&x.formats['text/html'])||''),source:'gutendex'};});}catch(e){return[];} }
async function ieSearchLOC(q){ try{ const r=await fetch('https://www.loc.gov/search/?fo=json&c=3&q='+encodeURIComponent(q),Object.assign({headers:{'User-Agent':'TheaIE/1.0'}},_ieTO())); if(!r.ok)return[]; const d=await r.json(); return ((d.results)||[]).slice(0,3).map(function(x){return{title:(Array.isArray(x.title)?x.title[0]:x.title)||'',summary:((x.description&&(Array.isArray(x.description)?x.description[0]:x.description))||'').toString().slice(0,1800),url:(x.id||x.url||''),source:'loc'};});}catch(e){return[];} }


async function ieSearchDevto(q){ try{ const r=await fetch('https://dev.to/api/articles?per_page=3&tag='+encodeURIComponent(String(q).toLowerCase().replace(/[^a-z0-9]+/g,'')),_ieTO()); if(!r.ok)return[]; const d=await r.json(); return (Array.isArray(d)?d:[]).slice(0,3).map(function(x){return{title:x.title||'',summary:((x.description||'')+' tags: '+((x.tag_list||[]).join(', '))).slice(0,1800),url:x.url||'',source:'devto'};});}catch(e){return[];} }
// ── MAIN RUN LOOP ─────────────────────────────────────────────────────────────
async function run() {
  const runId = randomUUID();
  console.log('[IE] Cycle start', new Date().toISOString());

  // Check Ollama availability
  let ollamaAvailable = false;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) { ollamaAvailable = true; console.log('[IE] Ollama available — synthesis enabled'); }
  } catch(e) { console.log('[IE] Ollama not available — research-only mode'); }

  // Get and rotate active learning program
  const activeProgramKey = await getActiveProgram();
  const activeProgram = PROGRAMS[activeProgramKey];
  console.log(`[IE] Active program: ${activeProgram.name}`);

  // Inject program topics if not already in registry
  await addProgramTopics(activeProgramKey);

  const registry = await loadTopics();
  const topics = pickTopics(registry);
  console.log('[IE] Topics:', topics.join(' | '));

  const allFindings = [], allAtoms = [], allSynthesisAtoms = [];

  for (const topic of topics) {
    console.log('[IE] Researching:', topic.slice(0,50));
    try {
      const [w,ax,oa,hn,pm,wd,wb,tv,cr,ss,ep,pl,se,gh,nh,dj,zn,ol,gd,lc,dv] = await Promise.allSettled([
        searchWikipedia(topic), searchArxiv(topic), searchOpenAlex(topic),
        searchHackerNews(topic), searchPubMed(topic), searchWikidata(topic),
        searchWorldBank(topic), searchTavily(topic), ieSearchCrossref(topic), ieSearchSemanticScholar(topic), ieSearchEuropePMC(topic), ieSearchPLOS(topic), ieSearchStackExchange(topic), ieSearchGithub(topic), ieSearchNIH(topic), ieSearchDOAJ(topic), ieSearchZenodo(topic), ieSearchOpenLibrary(topic), ieSearchGutendex(topic), ieSearchLOC(topic), ieSearchDevto(topic),
      ]);
      const sources = { wikipedia:w.value||[], arxiv:ax.value||[], openalex:oa.value||[], hackernews:hn.value||[], pubmed:pm.value||[], wikidata:wd.value||[], worldbank:wb.value||[], tavily:tv.value||[], crossref:cr.value||[], semanticscholar:ss.value||[], europepmc:ep.value||[], plos:pl.value||[], stackexchange:se.value||[], github_code:gh.value||[], nih_reporter:nh.value||[], doaj:dj.value||[], zenodo:zn.value||[], openlibrary:ol.value||[], gutendex:gd.value||[], loc:lc.value||[], devto:dv.value||[] };
      let count = 0;
      const topicFindings = [];
      Object.entries(sources).forEach(([src, results]) => {
        results.forEach(r => {
          if (!r.title) return;
          const rel = scoreResult(r, topic);
          const ts = new Date().toISOString();
          // STAGE C: widen summary (300→1500) and claim (500→1800) so deep content survives
          const finding = { id: randomUUID(), ts, query:topic, source:src, title:r.title, summary:(r.summary||'').slice(0,1500), url:r.url||'', relevance:rel, runId, program: activeProgramKey };
          allFindings.push(finding);
          topicFindings.push(finding);
          allAtoms.push(buildAtom({
            kind: 'research-finding',
            claim: (r.title + ': ' + (r.summary || '')).slice(0, 1800),
            source_url: r.url || null,
            finding_source: src,
            relevance: rel,
            topic,
            program: activeProgramKey,
          }));
          count++;
        });
      });
      console.log('[IE]  ->', count, 'results across', Object.values(sources).filter(a=>a.length).length, 'sources');

      // ── SYNTHESIS — UNIFIED PATH (Stage 4.5 open-domain) ──
      // Both Ollama and Claude paths produce atoms through buildAtom().
      // No hardcoded coords. No constant confidence. Evidence decides.
      // generated_by tag distinguishes which model thought the insight;
      // the atom's discipline, coords, and confidence all come from content.
      if (ollamaAvailable && topicFindings.length >= 3) {
        const insights = await ollamaSynthesize(topicFindings, topic, activeProgram.name);
        if (insights.length) {
          console.log(`[IE]  -> Ollama synthesised ${insights.length} insights`);
          insights.forEach(insight => {
            allSynthesisAtoms.push(buildAtom({
              kind: 'synthesis',
              claim: insight.slice(0, 500),
              findings: topicFindings,
              topic,
              program: activeProgramKey,
              generated_by: 'ollama',
            }));
          });
        }
      } else if (!ollamaAvailable && CLAUDE_KEY && topicFindings.length >= 4) {
        const insights = await claudeSynthesize(topicFindings, topic);
        if (insights.length) {
          console.log(`[IE]  -> Claude synthesised ${insights.length} insights`);
          insights.forEach(insight => {
            allSynthesisAtoms.push(buildAtom({
              kind: 'synthesis',
              claim: insight.slice(0, 500),
              findings: topicFindings,
              topic,
              program: activeProgramKey,
              generated_by: 'claude',
            }));
          });
        }
      }

    } catch(e) { console.error('[IE] Error on topic:', e.message); }
    await new Promise(r => setTimeout(r, 600));
  }

  // Save all to Supabase
  let savedF = 0, savedA = 0, savedS = 0;
  for (let i=0; i<allFindings.length; i+=50) {
    const batch = allFindings.slice(i,i+50).map(f => ({ id:f.id, data:f, _ts:f.ts }));
    const { error } = await supa.from('thea_ie_findings').upsert(batch, { onConflict:'id', ignoreDuplicates:true });
    if (!error) savedF += batch.length; else console.warn('[IE] Findings error:', error.message);
  }
  const allAtomsCombined = [...allAtoms, ...allSynthesisAtoms];
  for (let i=0; i<allAtomsCombined.length; i+=50) {
    const batch = allAtomsCombined.slice(i,i+50).map(a => ({ id:a.id, data:a, _ts:new Date(a.ts).toISOString() }));
    const { error } = await supa.from('thea_atoms').upsert(batch, { onConflict:'id', ignoreDuplicates:true });
    if (!error) { savedA += batch.length; savedS += allSynthesisAtoms.length > 0 ? Math.min(batch.length, allSynthesisAtoms.length) : 0; }
    else console.warn('[IE] Atoms error:', error.message);
  }

  await markResearched(topics);

  const newTopics = extractNewTopics(allFindings, registry);
  if (newTopics.length) await addNewTopics(newTopics, topics[0]);

  // Rotate program every 3 cycles (tracked via research_count of program marker)
  try {
    const { data } = await supa.from('thea_ie_topics').select('research_count').eq('id', CURRENT_PROGRAM_KEY).single();
    const cycleCount = (data?.research_count || 0) + 1;
    await supa.from('thea_ie_topics').upsert([{ id: CURRENT_PROGRAM_KEY, topic: activeProgramKey, category: 'system', priority: 10, research_count: cycleCount, last_researched: new Date().toISOString(), added_at: new Date().toISOString() }], { onConflict: 'id' });
    if (cycleCount % 3 === 0) {
      const next = await rotateProgram(activeProgramKey);
      console.log(`[IE] Program rotated: ${activeProgramKey} → ${next}`);
    }
  } catch(e) {}

  try {
    await supa.from('thea_ie_cycle_log').upsert([{
      id: runId,
      data: { runId, topics, registrySize: registry.length + newTopics.length, findingsCount: savedF, atomsCount: savedA, synthesisAtoms: allSynthesisAtoms.length, newTopics: newTopics.length, program: activeProgramKey, ollamaUsed: ollamaAvailable, ts: new Date().toISOString() },
      _ts: new Date().toISOString()
    }]);
  } catch(e) { console.warn('[IE] Log error:', e.message); }

  try {
    await supa.from('thea_ie_findings').delete().lt('_ts', new Date(Date.now()-30*24*3600000).toISOString());
  } catch(e) { console.warn('[IE] Cleanup error:', e.message); }

  console.log(`[IE] Done: ${savedF} findings · ${savedA} atoms (${allSynthesisAtoms.length} synthesised) · ${newTopics.length} new topics · program: ${activeProgram.name}`);
}

run().catch(e => { console.error('[IE] FATAL:', e.message); console.error(e.stack); process.exit(1); });
