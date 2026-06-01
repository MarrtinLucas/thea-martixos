// ═══════════════════════════════════════════════════════════════════════════
// brain-core.js v2.1 — THEA BRAIN CORE (Stage 4.5)
// ═══════════════════════════════════════════════════════════════════════════
// REPLACES: brain-core.js v2 (Stage 4.5).
// ADDS (v2.1 — 2026-04-19):
//   • Streaming region aggregator with periodic flush (survives GH timeout)
//   • JSONB column projection: select only the ~11 keys rebuild needs, not
//     the full `data` blob. Typical atoms have url/summary/query/program
//     fields that inflate per-row payload to 3-5KB; projection cuts this
//     to ~400 bytes → 5-10× less network + serialization per page.
//   • Resume support: start_after_id / start_after_ts / batch_size opts
//   • Merge-with-existing on flush (atom_ids accumulate across resume runs)
//   • Time budget with graceful exit + cursor checkpoint to cycle log
//   • Removed destructive adaptive PAGE shrinking (was making things worse —
//     real bottleneck was per-row JSONB weight, not query count)
//   • Retries now use exponential backoff instead of page shrinkage
// v2 KEPT: 10D coordinate system, content-based discipline classifier,
//          coords_v2 read/write pattern, full backward compat with v1 coords.
//
// KEY PRINCIPLE: atoms are enriched once. Their coords_v2 values are frozen.
//                Region rebuild (separate operation) handles temporal drift.
//
// MIGRATION SAFETY: new field `coords_v2` stored alongside existing `coords`.
//                   Old field untouched. Reversal = DELETE coords_v2 column.
//
// RUNTIME: dual-mode (Node.js for GitHub Actions + browser for theasups).
// LLM USE: none. All deterministic rules.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const IS_NODE = (typeof window === 'undefined');
const IS_BROWSER = !IS_NODE;

// ─── SUPABASE CLIENT ──────────────────────────────────────────────────────
let supa = null;
async function _getSupaClient() {
  if (supa) return supa;
  if (IS_NODE) {
    const { createClient } = require('@supabase/supabase-js');
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_KEY env vars required');
    supa = createClient(url, key);
  } else {
    if (typeof S !== 'undefined' && S.supaClient) supa = S.supaClient;
    else throw new Error('S.supaClient not available — Thea not connected to Supabase yet');
  }
  return supa;
}

function _log(msg) {
  const prefix = '[brain-core ' + new Date().toISOString() + ']';
  if (IS_NODE) console.log(prefix, msg);
  else if (typeof addLine === 'function') addLine('SYS', '⬡ brain-core: ' + msg, 'sys-msg');
  else console.log(prefix, msg);
}

// ═══════════════════════════════════════════════════════════════════════════
// 10D COORDINATE SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

const NUMERIC_DIMS = [
  'TOPIC_SPEC', 'SOURCE_TIER', 'ABSTRACTION', 'NOVELTY', 'CONFIDENCE',
  'DENSITY', 'BEH', 'AFFECT', 'UTILITY', 'TIME'
];

// TIME dimension — how fresh the atom is.
//   10 = created today
//    5 = ~180 days old (exponential half-life)
//    1 = ~600+ days old (stale)
//    0 = unknown timestamp (safe default, neutral)
// Not decay-in-place — the value is computed at enrich-time from atom.ts.
// Index rebuilds re-compute it so routing always sees fresh TIME.
// Legacy atoms without coords_v2.TIME fall back to a neutral 5.
function _computeTIME(tsMs) {
  if (!tsMs || typeof tsMs !== 'number' || !isFinite(tsMs) || tsMs <= 0) return 5;
  const ageMs = Date.now() - tsMs;
  if (ageMs < 0) return 10;  // future timestamps (clock drift) — treat as very fresh
  const ageDays = ageMs / 86400000;
  // Exponential decay with 180-day half-life.
  // 0d = 10.0, 90d = 7.1, 180d = 5.0, 365d = 2.5, 730d = 0.6, 1095d = 0.15
  const v = 10 * Math.pow(0.5, ageDays / 180);
  return Math.max(0, Math.min(10, +v.toFixed(2)));
}

// ═══════════════════════════════════════════════════════════════════════════
// DISCIPLINE CLASSIFIER — content-based, extensible, never throws
// ═══════════════════════════════════════════════════════════════════════════

const DISCIPLINE_KEYWORDS = {
  psychology: ['behavior', 'behaviour', 'cognitive', 'cognition', 'mind', 'psychological',
               'emotion', 'motivation', 'decision making', 'bias', 'nudge', 'persuasion',
               'kahneman', 'tversky', 'thaler', 'cialdini', 'heuristic', 'intuition',
               'self concept', 'identity', 'attitude', 'personality', 'mental model',
               'intelligence', 'iq ', 'eq ', 'stress', 'anxiety', 'depression',
               'habit', 'habitual', 'addiction', 'reward system', 'dopamine reward',
               'mindfulness', 'therapy', 'cbt', 'subconscious', 'unconscious mind',
               'fear response', 'trauma', 'self esteem', 'resilience', 'grit',
               'flow state', 'peak experience', 'learned helplessness', 'locus of control',
               'tony robbins', 'maslow', 'jung', 'freud'],
  physics: ['quantum', 'relativity', 'particle', 'photon', 'electron', 'wave function',
            'thermodynamics', 'entropy', 'gravity', 'spacetime', 'field theory',
            'lagrangian', 'hamiltonian', 'boson', 'fermion', 'planck', 'einstein',
            'astronomy', 'cosmology', 'galaxy', 'solar system', 'black hole',
            'exoplanet', 'star formation', 'dark matter', 'dark energy',
            'astrophysics', 'nasa', 'space exploration', 'nebula', 'supernova',
            'telescope', 'orbital mechanics'],
  mathematics: ['theorem', 'proof', 'conjecture', 'lemma', 'corollary', 'equation',
                'prime number', 'integer', 'topology', 'manifold', 'calculus', 'algebra',
                'number theory', 'riemann', 'hilbert', 'gödel', 'category theory',
                'graph theory', 'combinatorics', 'set theory', 'p vs np'],
  philosophy: ['epistemology', 'ontology', 'metaphysics', 'phenomenology', 'consciousness',
               'qualia', 'free will', 'determinism', 'ethics', 'moral', 'virtue',
               'being', 'mind body', 'dualism', 'existentialism', 'nietzsche', 'kant',
               'heidegger', 'wittgenstein', 'socratic', 'stoic'],
  programming: ['algorithm', 'code', 'software', 'api', 'database', 'framework',
                'compile', 'debug', 'function', 'variable', 'javascript', 'python',
                'rust', 'golang', 'typescript', 'react', 'node', 'git', 'repository',
                'docker', 'kubernetes', 'sql', 'nosql', 'json', 'rest', 'graphql',
                'microservice', 'refactor', 'unit test'],
  biology: ['cell', 'gene', 'dna', 'rna', 'protein', 'evolution', 'species',
            'organism', 'enzyme', 'mutation', 'chromosome', 'phenotype', 'genotype',
            'natural selection', 'biology', 'molecular', 'cellular'],
  neuroscience: ['neuron', 'synapse', 'brain', 'cortex', 'hippocampus', 'amygdala',
                 'neural', 'neuroplasticity', 'dopamine', 'serotonin', 'neurotransmitter',
                 'fmri', 'eeg', 'cognitive neuroscience', 'prefrontal', 'default mode',
                 'consciousness', 'working memory'],
  business: ['market', 'revenue', 'customer', 'strategy', 'roi', 'acquisition',
             'retention', 'ltv', 'cac', 'churn', 'arr', 'mrr', 'saas', 'b2b', 'b2c',
             'valuation', 'funding', 'venture', 'startup', 'product market fit',
             'go to market', 'enterprise', 'procurement', 'pitch', 'pricing'],
  economics: ['inflation', 'recession', 'gdp', 'monetary policy', 'fiscal', 'supply',
              'demand', 'equilibrium', 'elasticity', 'macroeconomic', 'microeconomic',
              'keynes', 'friedman', 'behavioural economics', 'game theory', 'nash',
              'pareto', 'bond', 'interest rate', 'central bank'],
  linguistics: ['language', 'grammar', 'syntax', 'semantics', 'phonetic', 'morphology',
                'phonology', 'pragmatics', 'chomsky', 'saussure', 'translation',
                'bilingual', 'etymology', 'dialect', 'proto-language', 'indo-european'],
  arts: ['painting', 'sculpture', 'music', 'composition', 'melody', 'harmony',
         'rhythm', 'aesthetic', 'baroque', 'romantic', 'modernism', 'abstract',
         'renaissance', 'impressionism', 'bauhaus', 'picasso', 'bach', 'beethoven'],
  history: ['empire', 'dynasty', 'revolution', 'war', 'century', 'medieval',
            'renaissance', 'industrial revolution', 'colonialism', 'civilization',
            'rome', 'greece', 'china', 'mesopotamia', 'historical'],
  design_ux: ['user interface', 'ui', 'ux', 'usability', 'accessibility', 'wcag',
              'nielsen', 'heuristic evaluation', 'user flow', 'wireframe', 'mockup',
              'design system', 'component library', 'tailwind', 'figma', 'sketch',
              'affordance', 'mental model', 'onboarding', 'conversion rate',
              'cta', 'landing page', 'information architecture'],
  ai_ml: ['machine learning', 'neural network', 'transformer', 'large language model', 'llm ',
          'gpt-', 'claude ', 'embedding space', 'attention mechanism', 'fine tuning',
          'rag pipeline', 'rlhf', 'tokenis', 'model inference', 'training data', 'foundation model',
          'gradient descent', 'backprop', 'overfit', 'regularisation', 'pytorch',
          'tensorflow', 'hugging face', 'ollama', 'language model', 'ai model',
          'diffusion model', 'generative ai', 'prompt engineering'],
  medicine: ['clinical', 'patient', 'diagnosis', 'treatment', 'therapy', 'drug',
             'pharmaceutical', 'disease', 'symptom', 'syndrome', 'cancer', 'virus',
             'bacteria', 'antibody', 'vaccine', 'surgery', 'cardiology', 'oncology',
             'psychiatry', 'neurology', 'pubmed', 'clinical trial'],
  sociology: ['society', 'social structure', 'culture', 'norm', 'institution',
              'class', 'status', 'group dynamics', 'collective', 'community',
              'durkheim', 'weber', 'marx', 'bourdieu', 'habitus', 'capital social'],
  law: ['jurisdiction', 'statute', 'regulation', 'court', 'ruling', 'precedent',
        'contract', 'tort', 'liability', 'constitutional', 'legal', 'plaintiff',
        'defendant', 'litigation', 'gdpr', 'compliance', 'intellectual property'],
  chemistry: ['molecule', 'compound', 'catalyst', 'organic chemistry',
              'inorganic chemistry', 'periodic table', 'polymer',
              'chromatography', 'spectroscopy', 'chemical reaction',
              'covalent', 'valence', 'ionic bond', 'hydrogen bond',
              'enzyme kinetics', 'stoichiometry', 'atomic number',
              'carbon atom', 'benzene', 'hydrocarbon', 'electrolyte',
              'crystalline', 'isotope'],
  statistics: ['probability', 'distribution', 'bayesian', 'frequentist', 'hypothesis',
               'p-value', 'confidence interval', 'regression', 'correlation',
               'variance', 'standard deviation', 'monte carlo', 'markov chain'],
  engineering: ['circuit', 'semiconductor', 'mechanical', 'thermal', 'structural',
                'aerodynamic', 'manufacturing', 'robotics', 'sensor', 'actuator',
                'pcb', 'fpga', 'vlsi', 'signal processing'],

  // ═══ MatrixOS-native disciplines (derived from your CB corpus) ═══
  decision_science: ['decision science', 'jdm theory', 'dual process theory',
                     'expected utility', 'prospect theory', 'bounded rationality',
                     'choice architecture', 'hyperbolic discounting',
                     'judgment under uncertainty', 'decision paralysis',
                     'decision fatigue', 'loss aversion'],
  behavioural_economics: ['behavioural economics', 'behavioral economics',
                          'behavioural econ', 'nudge theory', 'thaler',
                          'libertarian paternalism', 'framing theory',
                          'anchoring effect', 'endowment effect',
                          'default option', 'opt-in opt-out', 'choice overload'],
  cognitive_bias: ['cognitive bias', 'confirmation bias', 'availability heuristic',
                   'representative heuristic', 'sunk cost', 'status quo bias',
                   'hindsight bias', 'dunning-kruger', 'recency bias',
                   'survivorship bias', 'optimism bias', 'attribution error'],
  marketing_science: ['marketing science', 'ehrenberg-bass', 'double jeopardy',
                      'duplication of purchase', 'cpm', 'cac', 'ltv',
                      'penetration vs loyalty', 'byron sharp', 'mental availability',
                      'physical availability', 'distinctive assets'],
  network_theory: ['network theory', 'graph theory', 'small world', 'scale free',
                   'preferential attachment', 'six degrees', 'barabasi',
                   'network effects', 'metcalfe law', 'viral coefficient',
                   'information cascade', 'epidemic model'],
  systems_theory: ['systems thinking', 'systems theory', 'cybernetics',
                   'feedback loop', 'positive feedback', 'negative feedback',
                   'forrester', 'system dynamics', 'causal loop',
                   'stock and flow', 'leverage points', 'donella meadows'],
  operations_research: ['operations research', 'optimisation theory',
                        'linear programming', 'integer programming',
                        'constraint theory', 'theory of constraints',
                        'queueing theory', 'simplex method', 'np-hard',
                        'combinatorial optimisation'],
  game_theory: ['game theory', 'nash equilibrium', 'prisoner dilemma',
                'zero sum', 'non-cooperative', 'evolutionary game',
                'tit for tat', 'mixed strategy', 'minimax',
                'mechanism design', 'auction theory'],
  computational_creativity: ['computational creativity', 'generative ai',
                             'creative ai', 'divergent thinking',
                             'concept blending', 'conceptual space',
                             'style transfer', 'creative coding'],
  knowledge_management: ['knowledge management', 'tacit knowledge',
                         'explicit knowledge', 'community of practice',
                         'knowledge transfer', 'organisational learning',
                         'nonaka', 'ba concept'],
  strategic_foresight: ['strategic foresight', 'scenario planning',
                        'futures thinking', 'horizon scanning',
                        'wild card', 'weak signal', 'megatrend'],
  persuasion: ['persuasion', 'influence', 'cialdini', 'reciprocity principle',
               'commitment consistency', 'social proof', 'authority principle',
               'liking principle', 'scarcity principle', 'unity principle'],
  semiotics: ['semiotics', 'semiotic', 'saussure', 'peirce', 'signified',
              'signifier', 'icon index symbol', 'sign system', 'denotation',
              'connotation', 'myth roland barthes'],
  cultural_studies: ['cultural studies', 'hegemony', 'gramsci', 'hall stuart',
                     'encoding decoding', 'subculture', 'cultural capital',
                     'norm theory', 'ritual theory'],

  // ═══ Math Brain-native disciplines (from MB corpus) ═══
  glyph_math: ['glyph math', 'glyphmath', 'glyph operator', 'fog state',
               'fog depth', 'fog conservation', 'cleared path', 'gamma_fog',
               'gamma_clear', 'sdci', 'operator family', 'epsilon up',
               'eta down', 'kappa forward', 'omega stable', 'beta mutate'],
  analytic_number_theory: ['analytic number theory', 'riemann zeta',
                           'zeta function', 'l-function', 'prime counting',
                           'dirichlet', 'modular form', 'analytic continuation'],
  computational_complexity: ['computational complexity', 'p vs np',
                             'np-complete', 'np-hard', 'cook levin',
                             'circuit complexity', 'space complexity',
                             'randomized complexity', 'quantum complexity'],
  category_theory: ['category theory', 'functor', 'natural transformation',
                    'monad', 'adjoint', 'topos', 'yoneda', 'limit colimit'],
  algebraic_geometry: ['algebraic geometry', 'scheme', 'sheaf', 'variety',
                       'elliptic curve', 'modular form', 'zariski',
                       'grothendieck', 'motivic cohomology'],
  algebraic_topology: ['algebraic topology', 'homology', 'cohomology',
                       'homotopy', 'fundamental group', 'covering space',
                       'simplicial complex', 'chain complex'],
  mathematical_logic: ['mathematical logic', 'godel', 'incompleteness',
                       'model theory', 'proof theory', 'first order logic',
                       'second order logic', 'zermelo fraenkel', 'zfc',
                       'consistent axioms', 'decidability'],
  information_theory: ['information theory', 'shannon entropy', 'mutual information',
                       'channel capacity', 'kolmogorov complexity',
                       'minimum description length', 'mdl', 'kullback leibler',
                       'source coding'],
  quantum_computing: ['quantum computing', 'quantum algorithm', 'qubit',
                      'superposition quantum', 'entangled qubit', 'shor algorithm',
                      'grover algorithm', 'quantum gate', 'quantum circuit'],
  statistical_mechanics: ['statistical mechanics', 'partition function',
                          'ising model', 'phase transition', 'boltzmann',
                          'gibbs distribution', 'ensemble', 'free energy'],
  dynamical_systems: ['dynamical systems', 'chaos theory', 'strange attractor',
                      'lorenz', 'lyapunov', 'bifurcation', 'phase space',
                      'poincare', 'ergodic'],

  // ═══ Human Architecture — your own disciplines ═══
  sdci_architecture: ['sdci', 'deterministic ai', 'deterministic cognitive',
                      'synthetic deterministic', 'matrix os', 'matrixos',
                      'gap in the matrix'],
  decision_physics: ['decision physics', 'zone of temptation', 'decision fog',
                     'fog conservation law', 'clarity intrigue', 'thin slicing',
                     'gains architecture', 'pre-decision window'],
  shopper_psychology: ['shopper type', 'shopper archetype', 'buyer psychology',
                       'purchase psychology', 'ps-resolution', 'ps resolution',
                       'buyer delay', 'decision paralysis resolution'],
};

const CUSTOM_DISCIPLINES = {};

function registerDiscipline(name, keywords) {
  if (!name || !Array.isArray(keywords)) return false;
  CUSTOM_DISCIPLINES[name.toLowerCase()] = keywords.map(k => String(k).toLowerCase());
  return true;
}

function classifyDiscipline(atom) {
  try {
    if (!atom) return 'unclassified';

    // ── TIER 1: Explicit metadata from CB/MB/other structured sources ─
    // If the atom already carries its own discipline label, trust it.
    // Many atoms come from sources (CB, MB, structured APIs) that already
    // know what they are. We should not override them.
    const _clean = s => String(s).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

    if (atom.discipline && typeof atom.discipline === 'string'
        && atom.discipline !== 'unclassified' && atom.discipline.length > 2) {
      return _clean(atom.discipline);
    }
    if (atom.category && typeof atom.category === 'string' && atom.category.length > 2) {
      return _clean(atom.category);
    }
    if (atom.sub_category && typeof atom.sub_category === 'string' && atom.sub_category.length > 2) {
      return _clean(atom.sub_category);
    }
    // Only use domain if it looks like a real discipline (e.g. "analytic_number_theory"
    // from MB), not a source bucket (e.g. "cb-mission", "hackernews", "ie:arxiv").
    if (atom.domain && typeof atom.domain === 'string'
        && atom.domain.length > 2
        && !atom.domain.startsWith('cb-')
        && !atom.domain.startsWith('ie:')
        && !atom.domain.startsWith('project:')
        && !['hackernews','wikipedia','arxiv','openalex','pubmed','zenodo','wikidata',
             'doaj','loc','openlibrary','googlebooks','googlekg','ddg','tavily',
             'worldbank','ie','cb-mission','cb-ps','ollama_synthesis','claude_synthesis',
             'research-finding','synthesised-insight'].includes(atom.domain)
        && (atom.domain.includes('_') || atom.domain.length > 6)) {
      return _clean(atom.domain);
    }

    // ── TIER 2: Tag-based (known discipline tags) ──
    const text = String(atom.claim || '').toLowerCase();
    const tags = Array.isArray(atom.tags) ? atom.tags.map(t => String(t).toLowerCase()) : [];

    for (const tag of tags) {
      if (DISCIPLINE_KEYWORDS[tag] || CUSTOM_DISCIPLINES[tag]) return tag;
    }

    // ── TIER 3: Content keyword scoring ──
    const allKeywords = { ...DISCIPLINE_KEYWORDS, ...CUSTOM_DISCIPLINES };
    const scores = {};
    for (const [discipline, keywords] of Object.entries(allKeywords)) {
      let score = 0;
      for (const kw of keywords) {
        if (text.indexOf(kw) !== -1) score++;
        for (const tag of tags) {
          if (tag.indexOf(kw) !== -1) { score += 0.5; break; }
        }
      }
      if (score > 0) scores[discipline] = score;
    }

    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) {
      // Fallback: first clean tag becomes discipline (but filter junk tags).
      // v2.6: added project-name truncation heuristics to catch leaks like
      // "helping_thea_to_beco", "frist_principles", "run_atoms", "let_thea_become"
      // from early project tags. These truncated sentences were passing the
      // tag.length < 25 check and becoming faux disciplines.
      const TAG_EXCLUDE = ['ie', 'autonomous', 'synthesis', 'cb', 'mb',
                           'project', 'hackernews', 'wikipedia', 'pubmed',
                           'arxiv', 'openalex', 'zenodo', 'loc', 'doaj',
                           'wikidata', 'googlebooks', 'openlibrary', 'ddg',
                           'tavily', 'googlekg', 'worldbank', 'claude', 'ollama',
                           'thea', 'matrix', 'run', 'build', 'mission', 'query'];
      // Prefixes that mark a tag as a user-authored sentence/project title,
      // not a discipline name. These are either Thea's Projects-system prefixes
      // or natural-English question-starts that got truncated into tags.
      const PROJECT_PREFIXES = [
        'what ', 'what_', 'how ', 'how_', 'why ', 'why_', 'when ', 'when_',
        'where ', 'where_', 'do ', 'do_', 'does ', 'does_',
        'tell ', 'tell_', 'show ', 'show_', 'explore ', 'explore_',
        'find ', 'find_', 'get ', 'get_', 'give ', 'give_',
        'let ', 'let_', 'make ', 'make_', 'create ', 'create_',
        'build ', 'build_', 'run ', 'run_', 'extract ', 'extract_',
        'helping ', 'helping_', 'helping_thea', 'frist_', 'first_',
        'can_we', 'can_you', 'should_', 'could_', 'would_',
        'explain ', 'explain_', 'describe ', 'describe_',
      ];
      // Phrase indicators — if present in a tag, it's a sentence not a label.
      // These are English grammatical joiners that never appear in discipline names.
      const PHRASE_MARKERS = ['_the_', '_to_', '_of_', '_and_', '_for_', '_in_',
                              '_with_', '_that_', '_this_', '_at_', '_on_',
                              '_by_', '_from_', '_as_', '_but_', '_or_',
                              '_is_', '_are_', '_was_', '_were_', '_be_',
                              '_we_', '_you_', '_it_', '_can_', '_will_'];

      for (const tag of tags) {
        if (!tag || tag.length < 3 || tag.length >= 25) continue;
        if (TAG_EXCLUDE.includes(tag)) continue;
        if (tag.startsWith('p_')) continue;           // project IDs
        if (/^\d/.test(tag)) continue;                // timestamp-like
        if (PROJECT_PREFIXES.some(p => tag.startsWith(p))) continue;
        if (PHRASE_MARKERS.some(m => tag.includes(m))) continue;
        // Underscore count heuristic — real disciplines rarely chain more than 3 parts.
        // "mathematics_physics_cognitive_science" (3 underscores) = legitimate cross-disc.
        // "helping_thea_to_beco" (3 underscores + starts with "helping") = project name.
        if (tag.split('_').length > 4) continue;
        return tag.replace(/[^a-z0-9_]+/g, '_').slice(0, 30) || 'unclassified';
      }
      return 'unclassified';
    }
    if (sorted.length === 1) return sorted[0][0];
    if (sorted[0][1] >= 2 * sorted[1][1]) return sorted[0][0];
    if (sorted[0][1] >= 3 && sorted[1][1] >= 3) return 'interdisciplinary';
    return sorted[0][0];
  } catch(e) { return 'unclassified'; }
}

// ═══════════════════════════════════════════════════════════════════════════
// COORDINATE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════

const BEH_VERBS = ['try', 'use', 'apply', 'buy', 'choose', 'pick', 'select', 'avoid',
                   'stop', 'start', 'build', 'create', 'do', 'should', 'must', 'always',
                   'never', 'click', 'tap', 'install', 'deploy'];
const AFFECT_WORDS = ['delight', 'fear', 'joy', 'sad', 'angry', 'excited', 'anxious',
                      'stressed', 'curious', 'fascinated', 'shock', 'surprise', 'critical',
                      'crucial', 'dangerous', 'beautiful', 'wonderful', 'terrible', 'love',
                      'hate', 'powerful', '!'];
const UTILITY_MARKERS = ['how to', 'step by step', 'tutorial', 'guide', 'recipe',
                         'checklist', 'framework', 'template', 'formula', 'method',
                         'technique', 'strategy', 'tactic', 'implementation'];
const ABSTRACT_MARKERS = ['theory', 'concept', 'principle', 'paradigm', 'meta',
                          'philosophical', 'foundational', 'axiom', 'abstraction',
                          'generalisation', 'universal', 'ontological', 'epistemic'];
const NOVELTY_NEW = ['2024', '2025', '2026', 'recent', 'emerging', 'breakthrough',
                     'frontier', 'cutting edge', 'latest', 'novel', 'newly discovered'];
const NOVELTY_OLD = ['classical', 'traditional', 'established', 'well-known',
                     'textbook', 'foundational', 'ancient', 'historical'];

function _score(text, words) {
  let n = 0;
  for (const w of words) if (text.indexOf(w) !== -1) n++;
  return n;
}
function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function computeCoords(atom) {
  try {
    if (!atom) return _defaultCoords();

    const claim = String(atom.claim || '').toLowerCase();
    const tags = Array.isArray(atom.tags) ? atom.tags : [];
    const source = String(atom.source || '').toLowerCase();
    const type = String(atom.type || '').toLowerCase();
    const claimLen = claim.length;
    const wordCount = claim.split(/\s+/).length;
    const atomConfidence = typeof atom.confidence === 'number' ? atom.confidence : 0.5;

    // TOPIC_SPEC
    const properNouns = (String(atom.claim || '').match(/[A-Z][a-z]{2,}/g) || []).length;
    const hasNumbers = /\b\d+(\.\d+)?\b/.test(claim);
    const hasTechnical = /\b(algorithm|protocol|framework|methodology|syndrome|isotope)\b/.test(claim);
    let topicSpec = 3 + Math.min(properNouns, 4) + (hasNumbers ? 1 : 0) + (hasTechnical ? 1 : 0);
    if (claimLen < 50) topicSpec -= 2;
    if (claimLen > 200) topicSpec += 1;
    topicSpec = _clamp(topicSpec, 0, 10);

    // SOURCE_TIER
    let sourceTier = 5;
    if (source.includes('cb:') || source.includes('central_brain') || type.includes('axiom')) sourceTier = 10;
    else if (source.includes('mb:') || source.includes('math_brain')) sourceTier = 10;
    else if (source.includes('arxiv') || source.includes('pubmed') || source.includes('openalex')) sourceTier = 7;
    else if (source.includes('zenodo') || source.includes('doaj') || source.includes('worldbank')) sourceTier = 7;
    else if (source.includes('wikipedia') || source.includes('wikidata') || source.includes('googlebooks')) sourceTier = 6;
    else if (source.includes('openlibrary') || source.includes('loc') || source.includes('googlekg')) sourceTier = 6;
    else if (source.includes('hackernews') || source.includes('ddg') || source.includes('tavily')) sourceTier = 3;
    else if (source.includes('synthesis') || source.includes('ollama') || type.includes('synthesised')) sourceTier = 5;
    else if (source.includes('thea_response') || source.includes('manual')) sourceTier = 4;
    if (atom.qualityTier === 'high') sourceTier = Math.min(10, sourceTier + 1);
    sourceTier = _clamp(sourceTier, 0, 10);

    // ABSTRACTION
    let abstraction = 5;
    abstraction += _score(claim, ABSTRACT_MARKERS);
    if (/\b(theorem|proof|lemma|conjecture)\b/.test(claim)) abstraction += 2;
    if (/\b(example|case study|instance|specifically)\b/.test(claim)) abstraction -= 2;
    if (/\b(thing|object|device|tool|product)\b/.test(claim)) abstraction -= 1;
    abstraction = _clamp(abstraction, 0, 10);

    // NOVELTY
    let novelty = 5;
    novelty += _score(claim, NOVELTY_NEW);
    novelty -= _score(claim, NOVELTY_OLD);
    if (type.includes('synthesised') || type.includes('insight')) novelty += 2;
    novelty = _clamp(novelty, 0, 10);

    // CONFIDENCE (rescaled)
    const confidence = _clamp(Math.round(atomConfidence * 10), 0, 10);

    // DENSITY
    let density = 5;
    if (wordCount > 0) {
      const avgWordLen = claimLen / wordCount;
      if (avgWordLen > 7) density += 2;
      if (avgWordLen < 4) density -= 2;
    }
    if (/[=→↔⇒⇔]/.test(claim)) density += 2;
    if (claimLen < 80) density += 1;
    density = _clamp(density, 0, 10);

    // BEH
    let beh = _score(claim, BEH_VERBS);
    if (type.includes('nudge') || type.includes('ps-resolution') || source.includes('cb:ps')) beh += 3;
    if (source.includes('cb:mission')) beh += 2;
    beh = _clamp(beh, 0, 10);

    // AFFECT
    let affect = _score(claim, AFFECT_WORDS);
    if (/\?$/.test(String(atom.claim || ''))) affect += 1;
    affect = _clamp(affect, 0, 10);

    // UTILITY
    let utility = 3;
    utility += _score(claim, UTILITY_MARKERS) * 2;
    if (type.includes('nudge') || source.includes('cb:ps')) utility += 4;
    if (type.includes('research-finding')) utility -= 1;
    if (beh > 5) utility += 1;
    utility = _clamp(utility, 0, 10);

    // TIME dim — fresh from atom.ts if present, neutral default otherwise
    const time = _computeTIME(atom.ts);

    return { TOPIC_SPEC: topicSpec, SOURCE_TIER: sourceTier, ABSTRACTION: abstraction,
             NOVELTY: novelty, CONFIDENCE: confidence, DENSITY: density,
             BEH: beh, AFFECT: affect, UTILITY: utility, TIME: time };
  } catch(e) { return _defaultCoords(); }
}

function _defaultCoords() {
  return { TOPIC_SPEC: 5, SOURCE_TIER: 5, ABSTRACTION: 5, NOVELTY: 5,
           CONFIDENCE: 5, DENSITY: 5, BEH: 5, AFFECT: 5, UTILITY: 5, TIME: 5 };
}

function enrichAtom(atom) {
  if (!atom) return null;
  return { coords_v2: computeCoords(atom), discipline: classifyDiscipline(atom) };
}

// ═══════════════════════════════════════════════════════════════════════════
// REGION INDEX
// ═══════════════════════════════════════════════════════════════════════════

function _numericCoordsToCell(coords) {
  if (!coords) return NUMERIC_DIMS.map(() => 1).join('_');
  return NUMERIC_DIMS.map(d => {
    const v = coords[d];
    if (typeof v !== 'number') return 1;
    if (v < 3.34) return 0;
    if (v < 6.67) return 1;
    return 2;
  }).join('_');
}

function _effectiveCoords(atom) {
  if (atom.coords_v2 && typeof atom.coords_v2 === 'object') {
    const c = atom.coords_v2;
    if ('TOPIC_SPEC' in c || 'UTILITY' in c) {
      // v2 coords present. If TIME is missing (pre-v2.8 atoms), compute it now.
      if (typeof c.TIME !== 'number') {
        return { ...c, TIME: _computeTIME(atom.ts) };
      }
      return c;
    }
  }
  const old = atom.coords || {};
  return {
    TOPIC_SPEC: typeof old.FUN === 'number' ? old.FUN : 5,
    SOURCE_TIER: 5, ABSTRACTION: typeof old.TONE === 'number' ? old.TONE : 5,
    NOVELTY: 5, CONFIDENCE: typeof atom.confidence === 'number' ? Math.round(atom.confidence * 10) : 5,
    DENSITY: 5, BEH: typeof old.BEH === 'number' ? old.BEH : 5,
    AFFECT: typeof old.EMO === 'number' ? old.EMO : 5,
    UTILITY: typeof old.USE === 'number' ? old.USE : 5,
    TIME: _computeTIME(atom.ts),
  };
}

function _effectiveDiscipline(atom) {
  if (atom.discipline && typeof atom.discipline === 'string') return atom.discipline;
  return classifyDiscipline(atom);
}

function _centroid(atoms) {
  const sum = {};
  for (const d of NUMERIC_DIMS) sum[d] = 0;
  let n = 0;
  for (const a of atoms) {
    const c = _effectiveCoords(a);
    for (const d of NUMERIC_DIMS) sum[d] += (typeof c[d] === 'number' ? c[d] : 5);
    n++;
  }
  if (n === 0) { const z = {}; for (const d of NUMERIC_DIMS) z[d] = 5; return z; }
  const out = {};
  for (const d of NUMERIC_DIMS) out[d] = +(sum[d] / n).toFixed(2);
  return out;
}

function _dist(a, b) {
  let s = 0;
  for (const d of NUMERIC_DIMS) {
    const av = typeof a[d] === 'number' ? a[d] : 5;
    const bv = typeof b[d] === 'number' ? b[d] : 5;
    s += (av - bv) * (av - bv);
  }
  return Math.sqrt(s);
}

function _radius(atoms, centroid) {
  let max = 0;
  for (const a of atoms) {
    const d = _dist(_effectiveCoords(a), centroid);
    if (d > max) max = d;
  }
  return +max.toFixed(2);
}

function _representative(atoms) {
  if (!atoms.length) return null;
  return [...atoms].sort((x, y) => {
    const cx = x.confidence || 0, cy = y.confidence || 0;
    if (cx !== cy) return cy - cx;
    return (x.claim || '').length - (y.claim || '').length;
  })[0];
}

async function _logCycle(entry) {
  try {
    const client = await _getSupaClient();
    const id = 'index_cycle_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    await client.from('thea_index_cycle_log').insert({ id, data: entry, _ts: new Date().toISOString() });
  } catch(e) {
    if (!(e?.message || '').includes('does not exist')) {
      console.warn('[brain-core] Cycle log write failed:', e?.message || e);
    }
  }
}

async function rebuildBrainIndex(options) {
  // ═══════════════════════════════════════════════════════════════════════
  // v2.1 (2026-04-19) — streaming + projection + checkpoint + resume
  //
  // Opts accepted (all optional):
  //   atom_limit       — cap THIS run's atom count (null = unlimited)
  //   full_rebuild     — delete all existing regions at start
  //   start_after_id   — resume cursor (atom id; beats start_after_ts)
  //   start_after_ts   — resume cursor (_ts timestamp)
  //   batch_size       — page size (default 300; DO NOT go above 500 for
  //                      heavy JSONB atoms — PostgREST serialization cost
  //                      is linear in bytes, not rows)
  //   time_budget_ms   — soft stop before GH's hard timeout (default 5h)
  //
  // Behaviour:
  //   • Pages thea_atoms using keyset pagination on id (or _ts if resuming
  //     by timestamp). JSONB projection: only the ~11 fields the rebuild
  //     actually uses — cuts payload 5–10× vs selecting full `data` blob.
  //   • Streams atoms into in-memory region aggregator (discipline × grid-cell).
  //   • Flushes aggregator to thea_brain_index every 20 pages or 30s,
  //     whichever comes first. Flushing MERGES with existing region rows:
  //     atom_ids accumulate across resume runs.
  //   • Writes { last_atom_id, last_atom_ts, atoms_processed, phase } into
  //     thea_index_cycle_log.data on every flush → workflow auto-resume
  //     picks this up on next trigger.
  //   • Stops gracefully if atom_limit or time_budget_ms is exceeded.
  // ═══════════════════════════════════════════════════════════════════════

  options = options || {};
  const atomLimit     = options.atom_limit || null;
  const fullRebuild   = !!options.full_rebuild;
  const startAfterId  = options.start_after_id || null;
  const startAfterTs  = options.start_after_ts || null;
  const batchSize     = Math.min(500, Math.max(50, options.batch_size || 300));
  const timeBudgetMs  = options.time_budget_ms || (IS_NODE ? 5 * 60 * 60 * 1000 : 5 * 60 * 1000);
  const isResume      = !!(startAfterId || startAfterTs);

  const runId = 'run_' + Date.now();
  const startTs = Date.now();
  const cycleLog = {
    run_id: runId,
    started_at: new Date().toISOString(),
    mode: atomLimit ? 'cautious' : 'full',
    resume: isResume,
    atom_limit: atomLimit,
    batch_size: batchSize,
    full_rebuild: fullRebuild,
    env: IS_NODE ? 'github_actions' : 'browser',
    version: '2.1-streaming',
  };

  _log('Rebuild v2.1 starting · mode=' + cycleLog.mode +
       (atomLimit ? ' · cap=' + atomLimit : '') +
       (startAfterId ? ' · resume_id=' + String(startAfterId).slice(0, 12) + '...' : '') +
       (startAfterTs ? ' · resume_ts=' + startAfterTs : '') +
       ' · batch=' + batchSize);

  try {
    const client = await _getSupaClient();

    // Full rebuild wipes existing regions BEFORE we start streaming new ones.
    // Only allowed on a fresh run — a resume must not wipe what it's resuming.
    if (fullRebuild && !isResume) {
      _log('full_rebuild=true — deleting existing regions');
      await client.from('thea_brain_index').delete().gte('_ts', '1970-01-01');
    } else if (fullRebuild && isResume) {
      _log('⚠ full_rebuild ignored — cannot wipe during resume');
    }

    // ── Streaming aggregator ────────────────────────────────────────────
    // Map<regionKey → { region_id, discipline, cell_id, topic, atoms: [] }>
    // atoms[] only holds atoms from THIS run. On flush we merge with
    // any existing atom_ids already in the DB (resume-friendly).
    const regions = new Map();
    let atomsProcessed = 0;
    let pagesLoaded = 0;
    let lastLogAt = Date.now();
    let lastFlushAt = Date.now();
    const FLUSH_EVERY_N_PAGES = 20;   // ~6000 atoms at batch=300
    const FLUSH_EVERY_MS = 30_000;

    // Cursor: id (UUID) by default, _ts if caller specified ts-based resume
    const cursorCol = startAfterTs ? '_ts' : 'id';
    let cursor = startAfterTs || startAfterId || '';
    let lastAtomTs = null;   // track both for cycle log (workflow reads either)

    // ── Fetch with exponential backoff on timeout (no shrink) ──────────
    const fetchPageWithRetry = async () => {
      const MAX_RETRIES = 6;
      let lastErr = null;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          // JSONB PROJECTION — the payload-size fix.
          // Reads only keys the rebuild uses. Skips url / summary / query /
          // program / source_url / generated_by / evidence_count / source /
          // type — which is where most atom bytes live (esp. synthesis
          // atoms with 1800-char claims + full findings metadata).
          let q = client.from('thea_atoms')
            .select('id, _ts, data->>claim, data->coords_v2, data->coords, ' +
                    'data->>discipline, data->>category, data->>sub_category, ' +
                    'data->>domain, data->confidence, data->tags, data->ts')
            .order(cursorCol, { ascending: true })
            .limit(batchSize);
          if (cursor) q = q.gt(cursorCol, cursor);
          const res = await q;
          if (!res.error) return res.data || [];
          lastErr = res.error;
        } catch (e) { lastErr = e; }

        const msg = (lastErr && lastErr.message || '').toLowerCase();
        const isTimeout = msg.includes('timeout') || msg.includes('canceling') ||
                          msg.includes('statement') || msg.includes('upstream');
        _log('  page fetch attempt ' + (attempt + 1) + ' failed: ' +
             (lastErr && lastErr.message || '?').slice(0, 80));
        if (!isTimeout && attempt >= 2) break;   // non-timeout error → bail faster
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 64s
        await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
      }
      throw new Error('atom fetch failed after retries: ' +
                      (lastErr && lastErr.message || 'unknown'));
    };

    // ── Flush: write aggregator regions to DB, merging with existing ────
    const flush = async (isFinal) => {
      if (regions.size === 0) {
        if (isFinal) _log('  nothing to flush');
        return { written: 0, merged: 0 };
      }
      const regionIds = Array.from(regions.values()).map(r => r.region_id);

      // Fetch existing regions so we can merge atom_ids (resume-safe)
      let existingMap = new Map();
      if (!fullRebuild || isResume) {
        try {
          // .in() with a big array can be slow — chunk if needed
          const CHUNK = 100;
          for (let i = 0; i < regionIds.length; i += CHUNK) {
            const chunk = regionIds.slice(i, i + CHUNK);
            const { data: existing } = await client.from('thea_brain_index')
              .select('id, data').in('id', chunk);
            for (const row of (existing || [])) existingMap.set(row.id, row.data || {});
          }
        } catch (e) {
          console.warn('[brain-core] flush: existing-region read failed, proceeding without merge:', e.message);
        }
      }

      const rows = [];
      let mergedCount = 0;
      for (const region of regions.values()) {
        const atoms = region.atoms;
        if (atoms.length === 0) continue;
        const old = existingMap.get(region.region_id);
        // Merge atom_ids — Set union preserves existing ids across resume runs
        const atomIdSet = new Set(Array.isArray(old && old.atom_ids) ? old.atom_ids : []);
        for (const a of atoms) atomIdSet.add(a.id);
        const mergedAtomIds = Array.from(atomIdSet);
        if (old) mergedCount++;

        const centroid = _centroid(atoms);
        const radius = _radius(atoms, centroid);
        const rep = _representative(atoms);

        // Centroid/radius policy: if existing region is larger than this
        // run's sample, keep its centroid (more representative). Otherwise
        // use the freshly-computed one. Drift is acceptable — routing uses
        // cell_id (quantised) not centroid.
        const useOld = old && Array.isArray(old.atom_ids) &&
                       old.atom_ids.length > atoms.length;
        const finalCentroid = useOld ? old.coord_centroid : centroid;
        const finalRadius   = useOld ? old.coord_radius   : radius;
        const finalRep      = useOld ? old.representative_claim : (rep ? String(rep.claim).slice(0, 300) : '');
        const finalRepId    = useOld ? old.representative_atom_id : (rep ? rep.id : null);

        rows.push({
          id: region.region_id,
          data: {
            region_id: region.region_id,
            discipline: region.discipline,
            topic: region.topic,
            cell_id: region.cell_id,
            coord_centroid: finalCentroid,
            coord_radius: finalRadius,
            atom_ids: mergedAtomIds,
            atom_count: mergedAtomIds.length,
            representative_claim: finalRep,
            representative_atom_id: finalRepId,
            last_rebuilt: new Date().toISOString(),
            rebuild_source: 'index-cycle-v2.1',
            run_id: runId,
            schema_version: '10D-v2',
            cursor_at_write: cursor,
          },
          _ts: new Date().toISOString(),
        });
      }

      // Batch-write
      const BATCH = 100;
      let written = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const { error } = await client.from('thea_brain_index').upsert(batch, { onConflict: 'id' });
        if (error) console.warn('[brain-core] flush batch upsert failed:', error.message);
        else written += batch.length;
        if (IS_NODE) await new Promise(r => setTimeout(r, 50));
      }

      _log('  flushed ' + written + ' regions (' + mergedCount +
           ' merged with existing) · cursor=' + String(cursor).slice(0, 24));

      // Checkpoint cursor — the workflow auto-resume reads these fields
      cycleLog.atoms_processed = atomsProcessed;
      cycleLog.last_atom_id = (cursorCol === 'id') ? cursor : null;
      cycleLog.last_atom_ts = lastAtomTs || ((cursorCol === '_ts') ? cursor : null);
      cycleLog.regions_written = written;
      cycleLog.phase = isFinal ? 'complete' : 'streaming';
      await _logCycle({ ...cycleLog });
      lastFlushAt = Date.now();
      return { written, merged: mergedCount };
    };

    // ── Main loop ──────────────────────────────────────────────────────
    let stopReason = 'end-of-data';
    while (true) {
      if (atomLimit && atomsProcessed >= atomLimit) { stopReason = 'atom_limit'; break; }
      if (Date.now() - startTs > timeBudgetMs)      { stopReason = 'time_budget'; break; }

      const data = await fetchPageWithRetry();
      if (!data || data.length === 0) break;

      for (const row of data) {
        // Update cursor using whichever column we're paging on
        cursor = row[cursorCol];
        if (row._ts) lastAtomTs = row._ts;

        // Reconstruct atom shape from flat projection (helpers expect these keys)
        const a = {
          id: row.id,
          claim: row.claim || '',
          coords: row.coords || {},
          coords_v2: row.coords_v2 || null,
          discipline: row.discipline || null,
          category: row.category || null,
          sub_category: row.sub_category || null,
          domain: row.domain || '',
          confidence: (typeof row.confidence === 'number') ? row.confidence :
                      (typeof row.confidence === 'string') ? parseFloat(row.confidence) || 0.5 : 0.5,
          tags: Array.isArray(row.tags) ? row.tags : [],
          ts: (typeof row.ts === 'number') ? row.ts :
              (typeof row.ts === 'string') ? (parseInt(row.ts, 10) || Date.parse(row.ts) || 0) : 0,
        };
        if (!a.claim) continue;

        // Stream into aggregator
        const disc = _effectiveDiscipline(a);
        const cell = _numericCoordsToCell(_effectiveCoords(a));
        const regionKey = disc + '::' + cell;
        let region = regions.get(regionKey);
        if (!region) {
          const regionId = 'region_' + disc + '_' + cell;
          let topic = 'general';
          if (a.tags.length) {
            const usefulTag = a.tags.find(t => {
              const tl = String(t).toLowerCase();
              return !['ie', 'autonomous', 'synthesis', 'cb', 'mb'].includes(tl) && tl.length > 2;
            });
            if (usefulTag) topic = String(usefulTag).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
          }
          region = { region_id: regionId, discipline: disc, cell_id: cell, topic, atoms: [] };
          regions.set(regionKey, region);
        }
        region.atoms.push(a);
        atomsProcessed++;
      }

      pagesLoaded++;
      if (Date.now() - lastLogAt > 5000) {
        _log('  pages=' + pagesLoaded + ' atoms=' + atomsProcessed +
             ' regions=' + regions.size + ' PAGE=' + batchSize);
        lastLogAt = Date.now();
      }

      // Periodic flush — caps memory growth + checkpoints cursor
      if (pagesLoaded % FLUSH_EVERY_N_PAGES === 0 ||
          (Date.now() - lastFlushAt) > FLUSH_EVERY_MS) {
        await flush(false);
        // After flushing, we keep the region aggregator but clear atoms[] lists.
        // Next run through the flush merges with what we just wrote.
        for (const r of regions.values()) r.atoms = [];
      }

      if (data.length < batchSize) break;  // short page → end of data
      if (IS_NODE) await new Promise(r => setTimeout(r, 50));
    }

    // Final flush for any un-flushed atoms in aggregator
    const final = await flush(true);

    // ── Cycle log summary ──────────────────────────────────────────────
    cycleLog.atoms_processed = atomsProcessed;
    cycleLog.atoms_read = atomsProcessed;    // back-compat with older readers
    cycleLog.regions_built = regions.size;
    cycleLog.disciplines_found = new Set(Array.from(regions.values()).map(r => r.discipline)).size;
    cycleLog.last_atom_id = (cursorCol === 'id') ? cursor : null;
    cycleLog.last_atom_ts = lastAtomTs || ((cursorCol === '_ts') ? cursor : null);
    cycleLog.stop_reason = stopReason;
    cycleLog.status = 'ok';
    cycleLog.ended_at = new Date().toISOString();
    cycleLog.duration_ms = Date.now() - startTs;
    _log('Complete · ' + atomsProcessed + ' atoms · ' + regions.size +
         ' regions · stop=' + stopReason + ' · ' + cycleLog.duration_ms + 'ms');
    await _logCycle(cycleLog);

    return {
      regions_created: regions.size,
      atoms_read: atomsProcessed,
      atoms_processed: atomsProcessed,
      disciplines: cycleLog.disciplines_found,
      status: 'ok',
      duration_ms: cycleLog.duration_ms,
      run_id: runId,
      last_atom_id: cycleLog.last_atom_id,
      last_atom_ts: cycleLog.last_atom_ts,
      stop_reason: stopReason,
      completed: stopReason === 'end-of-data',
    };

  } catch (err) {
    cycleLog.status = 'failed';
    cycleLog.error = err.message || String(err);
    cycleLog.ended_at = new Date().toISOString();
    cycleLog.duration_ms = Date.now() - startTs;
    _log('FAILED: ' + cycleLog.error);
    await _logCycle(cycleLog);
    if (IS_NODE) throw err;
    return { status: 'failed', error: cycleLog.error };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// COORD ENRICHMENT
// ═══════════════════════════════════════════════════════════════════════════

async function enrichAtomCoords(options) {
  options = options || {};
  const dryRun = !!options.dry_run;
  const batchLimit = options.batch_limit || null;
  const onlyMissing = options.only_missing !== false;

  const runId = 'enrich_' + Date.now();
  const startTs = Date.now();
  const cycleLog = { run_id: runId, started_at: new Date().toISOString(),
                     mode: dryRun ? 'dry_run' : 'apply',
                     only_missing: onlyMissing, batch_limit: batchLimit };

  _log('Enrichment ' + (dryRun ? 'DRY-RUN' : 'APPLY')
       + (onlyMissing ? ' · only_missing=true' : ' · ALL atoms')
       + (batchLimit ? ' · cap=' + batchLimit : ''));

  try {
    const client = await _getSupaClient();
    // v2.1 — fixed PAGE, no adaptive shrink (shrinking made timeouts worse,
    // not better: the real bottleneck is per-row JSONB weight, not query
    // count). Exponential backoff retry replaces the shrink loop.
    const PAGE = Math.min(500, Math.max(50, options.batch_size || 300));
    const MAX_RETRIES = 6;
    let cursor = options.start_after_id || '';  // cursor-based pagination — start at beginning, advance by last seen id
    let processed = 0, wouldUpdate = 0, skipped = 0, errors = 0;
    let pagesLoaded = 0, lastLogAt = Date.now();
    const disciplineSample = {};
    const sampleEnrichments = [];

    while (true) {
      if (batchLimit && processed >= batchLimit) break;
      const remaining = batchLimit ? batchLimit - processed : null;
      const pageSize = remaining && remaining < PAGE ? remaining : PAGE;

      // Retry with exponential backoff — no page-size shrinking.
      // (Shrinking was the v2 behaviour and it demonstrably did not help:
      // the 2026-04-18 log shows PAGE going 500→250→125→62→50 while
      // per-atom latency kept climbing. Root cause is JSONB payload weight
      // + random heap I/O at UUID-ordered depth, not page size.)
      let data = null, error = null, ok = false;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        let query = client.from('thea_atoms').select('id, data')
          .order('id', { ascending: true }).limit(pageSize);
        if (cursor) query = query.gt('id', cursor);
        const res = await query;
        data = res.data; error = res.error;
        if (!error) { ok = true; break; }
        const msg = (error.message || '').toLowerCase();
        const isTimeout = msg.includes('timeout') || msg.includes('canceling') ||
                          msg.includes('statement') || msg.includes('upstream');
        _log('enrich page attempt ' + (attempt+1) + ' failed: ' + (error.message||'?').slice(0,80));
        if (!isTimeout && attempt >= 2) break;
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 64s
        await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
      }
      if (!ok) throw new Error('atom fetch failed after ' + MAX_RETRIES + ' retries: ' + (error && error.message));
      if (!data || data.length === 0) break;

      const toUpdate = [];
      for (const row of data) {
        processed++;
        cursor = row.id;  // advance cursor to last seen id
        const atom = row.data || {};
        if (!atom.claim) { skipped++; continue; }
        const hasV2 = atom.coords_v2 && typeof atom.coords_v2 === 'object';
        if (onlyMissing && hasV2) { skipped++; continue; }

        const enriched = enrichAtom(atom);
        if (!enriched) { skipped++; continue; }

        disciplineSample[enriched.discipline] = (disciplineSample[enriched.discipline] || 0) + 1;
        wouldUpdate++;

        if (sampleEnrichments.length < 5) {
          sampleEnrichments.push({
            id: row.id, claim_preview: String(atom.claim).slice(0, 100),
            source: atom.source, new_discipline: enriched.discipline,
            new_coords_v2: enriched.coords_v2
          });
        }

        if (!dryRun) {
          const updatedData = { ...atom, coords_v2: enriched.coords_v2, discipline: enriched.discipline };
          toUpdate.push({ id: row.id, data: updatedData, _ts: new Date().toISOString() });
        }
      }

      if (!dryRun && toUpdate.length) {
        const { error: upErr } = await client.from('thea_atoms').upsert(toUpdate, { onConflict: 'id' });
        if (upErr) { errors++; console.warn('[brain-core] enrichment batch error:', upErr.message); }
      }

      if (data.length < pageSize) break;  // reached the end
      if (IS_NODE) await new Promise(r => setTimeout(r, 100));
      _log('Progress · ' + processed + ' processed · ' + wouldUpdate
           + (dryRun ? ' would update' : ' updated')
           + ' · cursor=' + String(cursor).slice(-12));
    }

    cycleLog.atoms_processed = processed;
    cycleLog.atoms_enriched = wouldUpdate;
    cycleLog.atoms_skipped = skipped;
    cycleLog.write_errors = errors;
    cycleLog.discipline_sample = disciplineSample;
    cycleLog.sample_enrichments = sampleEnrichments;
    cycleLog.status = errors > 0 ? 'partial' : 'ok';
    cycleLog.ended_at = new Date().toISOString();
    cycleLog.duration_ms = Date.now() - startTs;

    _log('Enrichment complete · ' + processed + ' processed · '
         + wouldUpdate + (dryRun ? ' WOULD BE updated' : ' updated')
         + ' · ' + skipped + ' skipped · ' + errors + ' errors');

    await _logCycle(cycleLog);
    return { processed, enriched: wouldUpdate, skipped, errors,
             disciplines: disciplineSample, sample: sampleEnrichments,
             status: cycleLog.status, duration_ms: cycleLog.duration_ms, run_id: runId };

  } catch(err) {
    cycleLog.status = 'failed';
    cycleLog.error = err.message || String(err);
    cycleLog.ended_at = new Date().toISOString();
    cycleLog.duration_ms = Date.now() - startTs;
    _log('FAILED: ' + cycleLog.error);
    await _logCycle(cycleLog);
    if (IS_NODE) throw err;
    return { status: 'failed', error: cycleLog.error };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 5 — SEMANTIC ROUTING
// ═══════════════════════════════════════════════════════════════════════════
// The brain is now addressable. Queries get projected into 10D + classified
// into a discipline, then matched against the region index. We return the
// most relevant regions + their atoms, plus a reasoning trace explaining
// WHY these regions were chosen. That trace is the discipline signal —
// Thea can now explain herself.
//
// Core principle: Claude API is RENDERER ONLY. All routing computation
// happens in JavaScript. The trace is deterministic and inspectable.

// Disciplines that are considered "relatives" when matching. When the query
// lands on a specific discipline, we also search these for near-neighbour
// semantic content. Extend as the corpus evolves.
const _DISCIPLINE_NEIGHBOURS = {
  psychology:             ['neuroscience', 'philosophy', 'cognitive_bias', 'behavioural_economics', 'persuasion', 'decision_science'],
  neuroscience:           ['psychology', 'biology', 'medicine', 'ai_ml', 'philosophy'],
  philosophy:             ['psychology', 'mathematics', 'mathematical_logic', 'linguistics', 'history'],
  mathematics:            ['analytic_number_theory', 'category_theory', 'algebraic_topology', 'mathematical_logic', 'information_theory', 'statistical_mechanics', 'glyph_math'],
  physics:                ['mathematics', 'statistical_mechanics', 'dynamical_systems', 'quantum_computing', 'information_theory'],
  biology:                ['medicine', 'neuroscience', 'chemistry'],
  medicine:               ['biology', 'neuroscience', 'psychology'],
  ai_ml:                  ['programming', 'mathematics', 'information_theory', 'neuroscience', 'quantum_computing'],
  programming:            ['ai_ml', 'design_ux', 'engineering'],
  design_ux:              ['programming', 'psychology', 'cognitive_bias', 'persuasion', 'arts'],
  business:               ['marketing_science', 'decision_science', 'behavioural_economics', 'shopper_psychology', 'strategic_foresight', 'operations_research', 'game_theory'],
  sociology:              ['cultural_studies', 'psychology', 'network_theory', 'history'],
  decision_science:       ['behavioural_economics', 'cognitive_bias', 'psychology', 'persuasion', 'game_theory'],
  behavioural_economics:  ['decision_science', 'cognitive_bias', 'psychology', 'marketing_science'],
  cognitive_bias:         ['psychology', 'behavioural_economics', 'decision_science'],
  marketing_science:      ['business', 'shopper_psychology', 'persuasion', 'behavioural_economics', 'cognitive_bias'],
  shopper_psychology:     ['marketing_science', 'psychology', 'behavioural_economics', 'persuasion'],
  persuasion:             ['psychology', 'decision_science', 'marketing_science', 'cognitive_bias', 'semiotics'],
  network_theory:         ['systems_theory', 'mathematics', 'sociology', 'game_theory'],
  systems_theory:         ['network_theory', 'dynamical_systems', 'operations_research', 'glyph_math'],
  game_theory:            ['decision_science', 'operations_research', 'mathematics', 'business'],
  operations_research:    ['mathematics', 'business', 'systems_theory', 'game_theory'],
  information_theory:     ['mathematics', 'ai_ml', 'statistical_mechanics', 'computational_complexity', 'glyph_math'],
  computational_complexity: ['mathematics', 'algebraic_topology', 'mathematical_logic', 'information_theory'],
  mathematical_logic:     ['mathematics', 'philosophy', 'category_theory', 'computational_complexity'],
  analytic_number_theory: ['mathematics', 'algebraic_geometry', 'harmonic_analysis'],
  algebraic_topology:     ['mathematics', 'category_theory', 'differential_geometry'],
  category_theory:        ['mathematics', 'mathematical_logic', 'algebraic_topology'],
  dynamical_systems:      ['mathematics', 'physics', 'statistical_mechanics', 'systems_theory'],
  statistical_mechanics:  ['physics', 'mathematics', 'information_theory', 'dynamical_systems'],
  quantum_computing:      ['physics', 'computational_complexity', 'ai_ml', 'mathematics'],
  glyph_math:             ['mathematics', 'sdci_architecture', 'decision_physics', 'information_theory', 'systems_theory'],
  sdci_architecture:      ['glyph_math', 'decision_physics', 'ai_ml', 'shopper_psychology'],
  decision_physics:       ['decision_science', 'sdci_architecture', 'glyph_math', 'psychology', 'behavioural_economics'],
  linguistics:            ['semiotics', 'philosophy', 'cultural_studies'],
  semiotics:              ['linguistics', 'cultural_studies', 'persuasion'],
  cultural_studies:       ['sociology', 'semiotics', 'history'],
  history:                ['philosophy', 'sociology', 'cultural_studies'],
  arts:                   ['design_ux', 'cultural_studies'],
  law:                    ['philosophy', 'sociology', 'history', 'business'],
  chemistry:              ['biology', 'physics', 'medicine'],
  engineering:            ['programming', 'physics', 'ai_ml'],
};

function _relatedDisciplines(discipline) {
  const out = new Set([discipline]);
  const neighbours = _DISCIPLINE_NEIGHBOURS[discipline] || [];
  for (const n of neighbours) out.add(n);
  // Interdisciplinary region always considered — cross-domain insights live here
  out.add('interdisciplinary');
  return out;
}

/**
 * Route a user query to the most relevant regions + atoms.
 *
 * Algorithm:
 *   1. Build a pseudo-atom from the query text
 *   2. Classify its discipline via the existing brain-core classifier
 *   3. Compute its 10D target coords
 *   4. Fetch regions from thea_brain_index, filter to {discipline + neighbours}
 *   5. Score each region by Euclidean distance of centroid to query coords
 *   6. Take top N regions, fetch their atoms, dedupe
 *   7. Write a reasoning trace to thea_reasoning_trace (deterministic, inspectable)
 *   8. Return { trace_id, query_discipline, regions, atoms }
 *
 * Options:
 *   max_regions        — how many regions to include (default 8)
 *   atoms_per_region   — cap per region (default 25)
 *   max_atoms_total    — hard ceiling (default 120)
 *   extra_disciplines  — additional disciplines to include beyond neighbours
 *   skip_trace         — if true, don't write to thea_reasoning_trace (testing)
 */
async function routeQuery(queryText, options) {
  options = options || {};
  const maxRegions     = options.max_regions || 8;
  const atomsPerRegion = options.atoms_per_region || 25;
  const maxAtomsTotal  = options.max_atoms_total || 120;
  const extraDisc      = options.extra_disciplines || [];
  const skipTrace      = options.skip_trace === true;

  const traceId = 'trace_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();

  // ── 1. Build pseudo-atom from the query
  const queryAtom = {
    claim: String(queryText || '').slice(0, 500),
    source: 'query',
    tags: ['query'],
    confidence: 0.5,
  };

  // ── 2. Classify its discipline
  const queryDiscipline = classifyDiscipline(queryAtom);

  // ── 3. Compute target coords in 10D
  const queryCoords = computeCoords(queryAtom);

  // ── 4. Determine which disciplines to search
  const disciplinesToSearch = _relatedDisciplines(queryDiscipline);
  for (const d of extraDisc) disciplinesToSearch.add(d);

  let client;
  try { client = await _getSupaClient(); }
  catch (e) {
    return { trace_id: traceId, query_discipline: queryDiscipline,
             query_coords: queryCoords, disciplines_searched: [...disciplinesToSearch],
             regions: [], atoms: [], error: 'supabase_unavailable: ' + e.message };
  }

  // ── 5. Fetch candidate regions (filtered server-side by discipline)
  // Use .in() filter on nested jsonb via postgrest
  const discArr = [...disciplinesToSearch];
  let regionRows;
  try {
    // Fetch all regions matching any of the candidate disciplines.
    // Postgrest .or() with cs (contains) doesn't work for scalar jsonb,
    // so we query with .in() on the flattened discipline field.
    // The index stores data->>discipline so we filter with a jsonb path.
    const { data, error } = await client.from('thea_brain_index')
      .select('id, data')
      .in('data->>discipline', discArr);
    if (error) throw new Error(error.message);
    regionRows = data || [];
  } catch (e) {
    // Fallback: fetch all regions and filter client-side
    const { data, error } = await client.from('thea_brain_index')
      .select('id, data').limit(5000);
    if (error) {
      return { trace_id: traceId, query_discipline: queryDiscipline,
               query_coords: queryCoords, disciplines_searched: discArr,
               regions: [], atoms: [], error: 'region_fetch_failed: ' + error.message };
    }
    regionRows = (data || []).filter(r => {
      const disc = (r.data && r.data.discipline) || '';
      return disciplinesToSearch.has(disc);
    });
  }

  // ── 6. Score each region by distance of centroid → query.
  // TIME-AWARE ROUTING (Stage 7): if the query implies recency, give high-TIME
  // regions a boost. "what's new in X" → prefer fresh content.
  // "fundamentals of X" → TIME neutral (lower weight on TIME dim in scoring).
  const queryLower = String(queryText || '').toLowerCase();
  const recencyWords = /\b(recent|latest|today|yesterday|this week|this month|currently|now|new|newest|just|emerging|breaking)\b/;
  const timelessWords = /\b(fundamental|classic|foundation|timeless|history|origin|principle|theorem|axiom|theory)\b/;
  let timeWeight = 1.0;   // default: TIME counts as much as other dims
  if (recencyWords.test(queryLower))   timeWeight = 2.5;  // heavily prefer fresh atoms
  else if (timelessWords.test(queryLower)) timeWeight = 0.3;  // mostly ignore age
  const wantsFresh = timeWeight > 1.5;

  const scored = regionRows.map(r => {
    const region = r.data || {};
    const centroid = region.coord_centroid || {};
    // Weighted distance — TIME dim contribution scaled by timeWeight.
    // For recency queries, far-in-TIME regions (old atoms) are penalised more.
    let baseDist = _dist(queryCoords, centroid);
    if (timeWeight !== 1.0 && typeof centroid.TIME === 'number' && typeof queryCoords.TIME === 'number') {
      // Recompute with TIME contribution re-weighted
      let s = 0;
      for (const d of NUMERIC_DIMS) {
        const av = typeof queryCoords[d] === 'number' ? queryCoords[d] : 5;
        const bv = typeof centroid[d] === 'number' ? centroid[d] : 5;
        const w = (d === 'TIME') ? timeWeight : 1.0;
        s += w * (av - bv) * (av - bv);
      }
      baseDist = Math.sqrt(s);
    }
    return {
      region_id: region.region_id || r.id,
      discipline: region.discipline || 'unclassified',
      topic: region.topic || null,
      cell_id: region.cell_id || null,
      centroid,
      radius: region.coord_radius || 0,
      atom_ids: Array.isArray(region.atom_ids) ? region.atom_ids : [],
      atom_count: region.atom_count || 0,
      representative: region.representative_claim || null,
      distance: baseDist,
      region_time: typeof centroid.TIME === 'number' ? centroid.TIME : null,
    };
  }).sort((a, b) => a.distance - b.distance);

  // ── 7. Take top N regions, collect unique atom IDs up to cap
  const topRegions = scored.slice(0, maxRegions);
  const collectedIds = [];
  const seen = new Set();
  for (const r of topRegions) {
    for (const atomId of r.atom_ids.slice(0, atomsPerRegion)) {
      if (!seen.has(atomId)) { seen.add(atomId); collectedIds.push(atomId); }
      if (collectedIds.length >= maxAtomsTotal) break;
    }
    if (collectedIds.length >= maxAtomsTotal) break;
  }

  // ── 8. Fetch atom bodies (chunked to avoid URL length limits)
  const atoms = [];
  if (collectedIds.length) {
    for (let i = 0; i < collectedIds.length; i += 100) {
      const chunk = collectedIds.slice(i, i + 100);
      try {
        const { data, error } = await client.from('thea_atoms')
          .select('id, data').in('id', chunk);
        if (error) continue;
        for (const row of (data || [])) {
          const a = row.data || {};
          atoms.push({
            id: row.id,
            claim: a.claim || '',
            source: a.source || '',
            type: a.type || '',
            confidence: a.confidence || 0.5,
            discipline: a.discipline || null,
            tags: a.tags || [],
            url: a.url || null,
          });
        }
      } catch (e) { /* continue */ }
    }
  }

  const elapsedMs = Date.now() - t0;

  // ── 9. Build reasoning trace — deterministic, inspectable
  const trace = {
    trace_id: traceId,
    ts: new Date().toISOString(),
    query: String(queryText || '').slice(0, 500),
    query_discipline: queryDiscipline,
    query_coords: queryCoords,
    disciplines_searched: discArr,
    regions_considered: regionRows.length,
    regions_selected: topRegions.map(r => ({
      region_id: r.region_id,
      discipline: r.discipline,
      topic: r.topic,
      distance: +r.distance.toFixed(3),
      atoms_from_region: Math.min(r.atom_ids.length, atomsPerRegion),
      representative: r.representative ? String(r.representative).slice(0, 160) : null,
      region_time: r.region_time,
    })),
    atom_ids_retrieved: collectedIds.slice(0, maxAtomsTotal),
    atom_count: atoms.length,
    elapsed_ms: elapsedMs,
    time_weight: timeWeight,
    wants_fresh: wantsFresh,
    options: { maxRegions, atomsPerRegion, maxAtomsTotal },
  };

  // ── 10. Write trace to Supabase (fire-and-forget)
  if (!skipTrace) {
    client.from('thea_reasoning_trace').insert({
      id: traceId, data: trace, _ts: new Date().toISOString()
    }).then(() => {}, () => {});
  }

  return {
    trace_id: traceId,
    query: trace.query,
    query_discipline: queryDiscipline,
    query_coords: queryCoords,
    disciplines_searched: discArr,
    regions: trace.regions_selected,
    atoms: atoms,
    elapsed_ms: elapsedMs,
  };
}

/**
 * Given an atom ID, find the K nearest atoms by 10D coord distance,
 * prioritising atoms in the same discipline (and neighbour disciplines).
 */
async function nearestAtoms(atomId, k) {
  k = k || 50;
  if (!atomId) return { status: 'error', error: 'atomId required' };

  const client = await _getSupaClient();

  // Fetch seed atom
  const { data: seedRow, error: seedErr } = await client.from('thea_atoms')
    .select('id, data').eq('id', atomId).maybeSingle();
  if (seedErr || !seedRow) return { status: 'not_found', atomId };

  const seed = seedRow.data || {};
  const seedCoords = _effectiveCoords(seed);
  const seedDiscipline = _effectiveDiscipline(seed);
  const discSet = _relatedDisciplines(seedDiscipline);

  // Fetch regions in those disciplines
  let regions;
  try {
    const { data } = await client.from('thea_brain_index')
      .select('id, data').in('data->>discipline', [...discSet]);
    regions = data || [];
  } catch {
    regions = [];
  }

  // Pick the regions closest to the seed's coords
  const sortedRegions = regions.map(r => {
    const reg = r.data || {};
    return {
      atom_ids: Array.isArray(reg.atom_ids) ? reg.atom_ids : [],
      discipline: reg.discipline,
      distance: _dist(seedCoords, reg.coord_centroid || {}),
    };
  }).sort((a, b) => a.distance - b.distance).slice(0, 5);

  // Collect candidate atom IDs (excluding the seed itself)
  const candidateIds = new Set();
  for (const r of sortedRegions) {
    for (const id of r.atom_ids) if (id !== atomId) candidateIds.add(id);
    if (candidateIds.size > k * 3) break;
  }

  if (!candidateIds.size) {
    return { seed_id: atomId, seed_discipline: seedDiscipline, nearest: [], count: 0 };
  }

  // Fetch candidates + compute distance + sort
  const ids = [...candidateIds].slice(0, Math.max(k * 2, 200));
  const nearest = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      const { data } = await client.from('thea_atoms').select('id, data').in('id', chunk);
      for (const row of (data || [])) {
        const a = row.data || {};
        nearest.push({
          id: row.id,
          claim: (a.claim || '').slice(0, 200),
          discipline: _effectiveDiscipline(a),
          distance: _dist(_effectiveCoords(a), seedCoords),
        });
      }
    } catch {}
  }
  nearest.sort((a, b) => a.distance - b.distance);

  return {
    seed_id: atomId,
    seed_claim: (seed.claim || '').slice(0, 200),
    seed_discipline: seedDiscipline,
    disciplines_searched: [...discSet],
    regions_searched: sortedRegions.length,
    nearest: nearest.slice(0, k).map(n => ({ ...n, distance: +n.distance.toFixed(3) })),
    count: Math.min(nearest.length, k),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 6 — CONTINUOUS COGNITIVE CYCLES
// ═══════════════════════════════════════════════════════════════════════════
// These cycles run on GitHub Actions cron — ZERO browser dependency.
// Thea thinks on schedule regardless of whether her UI is open anywhere.
// Principle: any window/DOM reference here is a bug. Node-only paths.
//
// 6.1 Synthesis cycle     — daily 3am    — cross-region insight generation
// 6.2 Diary rollup cycle  — nightly 11pm — compresses the day
// 6.3 Graduation cycle    — weekly 4am   — promotes atoms through 5 tiers

// ── Graduation ladder thresholds (tunable) ───────────────────────────────
const GRADUATION_TIERS = {
  raw:                  { label: 'raw',                  min_citations: 0,  min_survived: 0, min_confidence: 0.00 },
  active:               { label: 'active',               min_citations: 5,  min_survived: 1, min_confidence: 0.60 },
  synthesis_confirmed:  { label: 'synthesis_confirmed',  min_citations: 15, min_survived: 2, min_confidence: 0.75 },
  graduation_candidate: { label: 'graduation_candidate', min_citations: 20, min_survived: 4, min_confidence: 0.85 },
  graduated:            { label: 'graduated',            min_citations: 0,  min_survived: 0, min_confidence: 0.00 },  // only reached via approval
};
const TIER_ORDER = ['raw', 'active', 'synthesis_confirmed', 'graduation_candidate', 'graduated'];

// Auto-graduate to CB/MB if quality_score >= this. Default: never. Must be
// explicitly enabled after Marty has reviewed 50+ candidates and trusts quality.
const AUTO_GRADUATE_THRESHOLD = 99.0;  // 99.0 = effectively disabled until explicitly set low

function _qualifyingTier(citations, survived, confidence) {
  for (let i = TIER_ORDER.length - 2; i >= 0; i--) {
    const tierName = TIER_ORDER[i];
    const t = GRADUATION_TIERS[tierName];
    if (citations >= t.min_citations && survived >= t.min_survived && confidence >= t.min_confidence) {
      return tierName;
    }
  }
  return 'raw';
}

function _tierIndex(tierName) {
  const i = TIER_ORDER.indexOf(tierName);
  return i < 0 ? 0 : i;
}

/**
 * Stage 6.1 — Synthesis cycle
 * Picks region pairs at high coord distance (cross-disciplinary), loads atoms
 * from each, asks Claude (as renderer only) to find genuine connections.
 * Writes results to thea_synthesis AND to thea_atoms (so they're routable by
 * Stage 5). Increments survived_cycles on source atoms.
 */
async function runSynthesisCycle(options) {
  options = options || {};
  const numPairs      = options.num_pairs || 10;
  const atomsPerSide  = options.atoms_per_side || 25;
  const maxPerCycle   = options.max_synthesis_per_cycle || 30;  // total cap
  const claudeKey     = options.claude_key || process.env.THEA_CLAUDE_KEY || process.env.CLAUDE_KEY || '';
  const claudeModel   = options.claude_model || 'claude-haiku-4-5-20251001';

  const runId = 'syn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const t0 = Date.now();
  _log('Synthesis cycle start · run=' + runId);

  if (!claudeKey) {
    return { status: 'failed', error: 'THEA_CLAUDE_KEY missing', run_id: runId };
  }

  const client = await _getSupaClient();

  // ── Load all regions (only sizeable ones qualify)
  const { data: regionRows, error: rErr } = await client.from('thea_brain_index')
    .select('id, data').limit(10000);
  if (rErr) return { status: 'failed', error: 'region_fetch: ' + rErr.message, run_id: runId };

  const regions = (regionRows || []).map(r => r.data || {})
    .filter(r => (r.atom_count || 0) >= 8 && Array.isArray(r.atom_ids));
  _log('Synthesis · ' + regions.length + ' eligible regions');

  if (regions.length < 2) {
    return { status: 'ok', synthesis_created: 0, note: 'insufficient regions', run_id: runId };
  }

  // ── Pick N cross-disciplinary region pairs at high coord distance
  const pairs = [];
  const triedKeys = new Set();
  // Sort regions by distance from every other — pick the far pairs across diff disciplines
  const maxAttempts = numPairs * 20;
  for (let attempt = 0; attempt < maxAttempts && pairs.length < numPairs; attempt++) {
    const a = regions[Math.floor(Math.random() * regions.length)];
    const b = regions[Math.floor(Math.random() * regions.length)];
    if (!a || !b || a.region_id === b.region_id) continue;
    if (a.discipline === b.discipline) continue;  // must be cross-discipline
    const key = [a.region_id, b.region_id].sort().join('|');
    if (triedKeys.has(key)) continue;
    triedKeys.add(key);
    const dist = _dist(a.coord_centroid || {}, b.coord_centroid || {});
    if (dist < 3.0) continue;  // too close — not meaningfully cross-disciplinary
    pairs.push({ a, b, distance: dist });
  }
  pairs.sort((x, y) => y.distance - x.distance);  // prefer farther pairs

  _log('Synthesis · ' + pairs.length + ' region pairs selected');

  const createdSynthesis = [];
  const sourceAtomCitations = new Map();  // atom_id → survived increments

  // ── Process each pair
  for (const pair of pairs) {
    if (createdSynthesis.length >= maxPerCycle) break;
    try {
      // Load atoms from each region
      const idsA = (pair.a.atom_ids || []).slice(0, atomsPerSide);
      const idsB = (pair.b.atom_ids || []).slice(0, atomsPerSide);
      if (idsA.length < 3 || idsB.length < 3) continue;

      const allIds = [...idsA, ...idsB];
      const atomsLoaded = [];
      for (let i = 0; i < allIds.length; i += 100) {
        const chunk = allIds.slice(i, i + 100);
        const { data } = await client.from('thea_atoms').select('id, data').in('id', chunk);
        for (const row of (data || [])) {
          const a = row.data || {};
          if (a.claim) atomsLoaded.push({ id: row.id, claim: a.claim, discipline: a.discipline, source: a.source });
        }
      }

      const atomsA = atomsLoaded.filter(a => idsA.includes(a.id));
      const atomsB = atomsLoaded.filter(a => idsB.includes(a.id));
      if (atomsA.length < 3 || atomsB.length < 3) continue;

      const claimsA = atomsA.map(a => '- ' + a.claim.slice(0, 200)).join('\n');
      const claimsB = atomsB.map(a => '- ' + a.claim.slice(0, 200)).join('\n');

      // ── Open-domain cross-region prompt (SAME philosophy as IE cycle — no forced framing)
      const prompt = `You are Thea. Below are observations from two distinct regions of your knowledge.

REGION A — discipline: ${pair.a.discipline} · topic: ${pair.a.topic || 'unspecified'}
${claimsA}

REGION B — discipline: ${pair.b.discipline} · topic: ${pair.b.topic || 'unspecified'}
${claimsB}

These regions are at coord distance ${pair.distance.toFixed(2)}. Are there GENUINE connections between them?

Produce 1-3 insights ONLY if the connection is real — a shared structural pattern, a mechanism that appears in both domains, a contradiction that reveals something, a compression that unifies them. Be skeptical. Forced metaphors are worse than silence.

If there's no genuine connection, say so briefly and produce zero insights. Better to say "no real connection found" than to confabulate.

Format: each insight on its own line, prefixed "INSIGHT:". Each insight should be 2-4 sentences, stating the connection plainly in whichever discipline's language fits best. If no insights, write "INSIGHT: none".`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: claudeModel,
          max_tokens: 800,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!r.ok) { _log('Synthesis · Claude error ' + r.status); continue; }
      const d = await r.json();
      const text = (d.content?.[0]?.text || '');

      const insights = text.split('\n')
        .filter(l => l.trim().startsWith('INSIGHT:'))
        .map(l => l.trim().replace(/^INSIGHT:\s*/, '').trim())
        .filter(l => l.length > 20 && l.toLowerCase() !== 'none');

      // ── Each insight becomes BOTH a thea_synthesis row AND a thea_atom (routable)
      for (const insightText of insights) {
        const synId = 'syn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

        // Confidence starts modest (cross-region synthesis is speculative)
        const conf = 0.55 + (pair.distance > 5 ? 0.05 : 0) + (atomsA.length + atomsB.length > 30 ? 0.05 : 0);

        // Build the atom shape — goes into thea_atoms, routable via Stage 5
        const atom = {
          id: synId,
          claim: insightText.slice(0, 500),
          source: 'synthesis:cross_region',
          type: 'cross-region-synthesis',
          tags: ['synthesis', 'cross_region', pair.a.discipline, pair.b.discipline],
          confidence: +conf.toFixed(2),
          generated_by: 'brain-synthesis-cycle',
          source_regions: [pair.a.region_id, pair.b.region_id],
          source_atom_ids: allIds,
          pair_distance: +pair.distance.toFixed(2),
          survived_cycles: 0,
          ts: Date.now(),
        };
        atom.coords_v2 = computeCoords(atom);
        atom.discipline = classifyDiscipline(atom);
        atom.activity_tier = 'raw';

        // Build the synthesis-specific record
        const synRecord = {
          synthesis_id: synId,
          tier: 'cross_region',
          claim: atom.claim,
          confidence: atom.confidence,
          source_regions: atom.source_regions,
          source_atom_ids: atom.source_atom_ids,
          coords: atom.coords_v2,
          discipline: atom.discipline,
          pair_disciplines: [pair.a.discipline, pair.b.discipline],
          pair_distance: atom.pair_distance,
          generated_by: 'brain-synthesis-cycle',
          claude_model: claudeModel,
          citation_count: 0,
          survived_cycles: 0,
          graduation_candidate: false,
          run_id: runId,
          ts: new Date().toISOString(),
        };

        // Parallel inserts
        await Promise.all([
          client.from('thea_synthesis').insert({ id: synId, data: synRecord, _ts: new Date().toISOString() }),
          client.from('thea_atoms').insert({ id: synId, data: atom, _ts: new Date().toISOString() }),
        ]);

        createdSynthesis.push(synId);
      }

      // Bump survived_cycles on source atoms regardless of how many insights were produced
      for (const aid of allIds) {
        sourceAtomCitations.set(aid, (sourceAtomCitations.get(aid) || 0) + 1);
      }

    } catch (e) {
      _log('Synthesis · pair failed: ' + e.message);
    }
  }

  // ── Bulk-update survived_cycles on source atoms
  // (Small UPDATE pass. Acceptable at this scale — if it grows, migrate to an RPC.)
  let cyclesUpdated = 0;
  if (sourceAtomCitations.size) {
    const sourceIds = [...sourceAtomCitations.keys()];
    for (let i = 0; i < sourceIds.length; i += 100) {
      const chunk = sourceIds.slice(i, i + 100);
      try {
        const { data } = await client.from('thea_atoms').select('id, data').in('id', chunk);
        if (!data) continue;
        const toUpdate = data.map(r => {
          const a = r.data || {};
          a.survived_cycles = (a.survived_cycles || 0) + (sourceAtomCitations.get(r.id) || 1);
          return { id: r.id, data: a, _ts: new Date().toISOString() };
        });
        await client.from('thea_atoms').upsert(toUpdate, { onConflict: 'id' });
        cyclesUpdated += toUpdate.length;
      } catch {}
    }
  }

  const elapsed = Date.now() - t0;
  const result = {
    run_id: runId,
    status: 'ok',
    synthesis_created: createdSynthesis.length,
    pairs_considered: pairs.length,
    source_atoms_updated: cyclesUpdated,
    elapsed_ms: elapsed,
    ts: new Date().toISOString(),
  };
  _log('Synthesis cycle done · ' + result.synthesis_created + ' insights · ' + elapsed + 'ms');
  await _logCycle({ cycle: 'synthesis', ...result });
  return result;
}

/**
 * Stage 6.2 — Diary rollup cycle
 * Compresses recent activity into a rollup document Thea reads on boot.
 * Sources: new atoms, IE findings, routing traces, synthesis.
 */
async function runDiaryRollup(dateStr) {
  const runId = 'diary_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const t0 = Date.now();
  const client = await _getSupaClient();

  // Default to yesterday (UTC) so the rollup captures a complete day
  const targetDate = dateStr || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const dayStart = new Date(targetDate + 'T00:00:00Z').toISOString();
  const dayEnd   = new Date(new Date(targetDate + 'T00:00:00Z').getTime() + 86400000).toISOString();

  _log('Diary rollup · day=' + targetDate + ' · run=' + runId);

  // ── Collect the day's activity (parallel)
  const [atomsRes, findingsRes, tracesRes, synRes] = await Promise.all([
    client.from('thea_atoms').select('id, data, _ts')
      .gte('_ts', dayStart).lt('_ts', dayEnd).limit(2000),
    client.from('thea_ie_findings').select('id, data, _ts')
      .gte('_ts', dayStart).lt('_ts', dayEnd).limit(500),
    client.from('thea_reasoning_trace').select('id, data, _ts')
      .gte('_ts', dayStart).lt('_ts', dayEnd).limit(500),
    client.from('thea_synthesis').select('id, data, _ts')
      .gte('_ts', dayStart).lt('_ts', dayEnd).limit(200),
  ]);

  const atoms    = (atomsRes.data || []).map(r => r.data || {});
  const findings = (findingsRes.data || []).map(r => r.data || {});
  const traces   = (tracesRes.data || []).map(r => r.data || {});
  const syntheses = (synRes.data || []).map(r => r.data || {});

  // ── Aggregate structured facts
  const disciplineCounts = {};
  for (const a of atoms) {
    const d = a.discipline || 'unclassified';
    disciplineCounts[d] = (disciplineCounts[d] || 0) + 1;
  }
  const topDisciplines = Object.entries(disciplineCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const queriesAsked = traces.map(t => t.query).filter(Boolean).slice(0, 40);
  const notableSyntheses = syntheses.filter(s => (s.confidence || 0) >= 0.7).slice(0, 8);

  // ── Compose a structured rollup (no LLM needed for this part)
  const rollupData = {
    rollup_date: targetDate,
    period: 'daily',
    atoms_added: atoms.length,
    findings_gathered: findings.length,
    queries_routed: traces.length,
    syntheses_produced: syntheses.length,
    discipline_breakdown: Object.fromEntries(topDisciplines),
    notable_syntheses: notableSyntheses.map(s => ({
      id: s.synthesis_id,
      claim_preview: (s.claim || '').slice(0, 160),
      pair: s.pair_disciplines,
      confidence: s.confidence,
    })),
    queries_sample: queriesAsked.slice(0, 20),
    run_id: runId,
    generated_at: new Date().toISOString(),
    generated_by: 'brain-diary-rollup-cycle',
  };

  // ── Optional natural-language summary (uses Claude if key present)
  const claudeKey = process.env.THEA_CLAUDE_KEY || process.env.CLAUDE_KEY || '';
  if (claudeKey && (atoms.length > 0 || syntheses.length > 0)) {
    try {
      const topQueries = queriesAsked.slice(0, 10).map(q => '- ' + q.slice(0, 100)).join('\n');
      const topSyn = notableSyntheses.slice(0, 5).map(s =>
        `- [${(s.pair_disciplines || []).join(' × ')}] ${(s.claim || '').slice(0, 200)}`
      ).join('\n');
      const discLines = topDisciplines.slice(0, 8).map(([d, n]) => `  ${d}: ${n}`).join('\n');

      const prompt = `Write a 250-word diary entry for Thea (a synthetic intelligence) reflecting on her activity from ${targetDate}. Be concrete, reference specifics, don't pad. Use first-person ("I ingested...", "I noticed...").

FACTS FROM THE DAY:
- Atoms added: ${atoms.length}
- Findings gathered: ${findings.length}
- Queries routed: ${traces.length}
- Cross-region syntheses: ${syntheses.length}

TOP DISCIPLINES OF THE DAY:
${discLines}

QUERIES I ROUTED:
${topQueries || '(none)'}

NOTABLE SYNTHESES I PRODUCED:
${topSyn || '(none)'}

Write the diary entry. Plain prose. No headers. End with 1-2 sentences about what I'm curious to explore tomorrow.`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (r.ok) {
        const d = await r.json();
        rollupData.summary_text = (d.content?.[0]?.text || '').trim();
      }
    } catch (e) {
      _log('Diary · Claude summary failed: ' + e.message);
    }
  }

  // ── Write the rollup
  const rollupId = 'rollup_' + targetDate;
  await client.from('thea_diary_rollup').upsert({
    id: rollupId,
    data: rollupData,
    _ts: new Date().toISOString(),
  }, { onConflict: 'id' });

  const elapsed = Date.now() - t0;
  const result = {
    run_id: runId,
    rollup_id: rollupId,
    status: 'ok',
    atoms_counted: atoms.length,
    findings_counted: findings.length,
    traces_counted: traces.length,
    syntheses_counted: syntheses.length,
    has_narrative_summary: !!rollupData.summary_text,
    elapsed_ms: elapsed,
  };
  _log('Diary rollup done · ' + targetDate + ' · ' + elapsed + 'ms');
  await _logCycle({ cycle: 'diary', ...result });
  return result;
}

/**
 * Stage 6.3 — Brain graduation cycle
 * Walks atoms through the 5-tier ladder based on citation_count (from traces),
 * survived_cycles (from synthesis), and confidence. Proposes CB/MB promotions
 * for Tier 3 candidates. Tier 4 requires manual approval by default.
 */
async function runBrainGraduation(options) {
  options = options || {};
  const sampleSize = options.sample_size || 5000;  // atoms to review per cycle
  const autoGraduateThreshold = options.auto_graduate_threshold || AUTO_GRADUATE_THRESHOLD;

  const runId = 'grad_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const t0 = Date.now();
  const client = await _getSupaClient();
  _log('Graduation cycle start · run=' + runId);

  // ── 1. Build citation counts from reasoning traces (last 30 days)
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: traceRows } = await client.from('thea_reasoning_trace')
    .select('data').gte('_ts', since).limit(10000);

  const citations = new Map();  // atom_id → count
  for (const row of (traceRows || [])) {
    const ids = ((row.data || {}).atom_ids_retrieved) || [];
    for (const id of ids) citations.set(id, (citations.get(id) || 0) + 1);
  }
  _log('Graduation · ' + citations.size + ' unique atoms cited across ' + (traceRows || []).length + ' traces');

  // ── 2. Review atom sample (prioritise high-citation atoms first)
  const citedIds = [...citations.keys()];
  const reviewIds = citedIds.slice(0, sampleSize);

  const tierChanges = { active: 0, synthesis_confirmed: 0, graduation_candidate: 0 };
  const newCandidates = [];
  const autoGraduated = [];

  for (let i = 0; i < reviewIds.length; i += 100) {
    const chunk = reviewIds.slice(i, i + 100);
    const { data } = await client.from('thea_atoms').select('id, data').in('id', chunk);
    if (!data) continue;

    const toUpdate = [];
    for (const row of data) {
      const atom = row.data || {};
      if (!atom.claim) continue;

      const cit = citations.get(row.id) || 0;
      const surv = atom.survived_cycles || 0;
      const conf = atom.confidence || 0.5;

      const currentTier = atom.activity_tier || 'raw';
      const qualifyingTier = _qualifyingTier(cit, surv, conf);

      if (_tierIndex(qualifyingTier) <= _tierIndex(currentTier)) continue;  // no promotion

      // ── Promotion path
      atom.activity_tier = qualifyingTier;
      atom.citation_count = cit;
      atom.tier_promoted_at = new Date().toISOString();

      // Bonus: atoms reaching synthesis_confirmed get a small confidence boost
      if (qualifyingTier === 'synthesis_confirmed') {
        atom.confidence = Math.min(0.95, (atom.confidence || 0.6) + 0.05);
      }

      toUpdate.push({ id: row.id, data: atom, _ts: new Date().toISOString() });
      tierChanges[qualifyingTier] = (tierChanges[qualifyingTier] || 0) + 1;

      // ── Tier 3: propose for graduation
      if (qualifyingTier === 'graduation_candidate') {
        const candidate = _proposeCandidate(atom, cit, surv);
        newCandidates.push(candidate);

        // Auto-graduation check (disabled by default)
        const qualityScore = (cit / 50) * 0.4 + surv * 0.15 + conf * 0.45;
        if (qualityScore >= autoGraduateThreshold) {
          candidate.status = 'auto_graduated';
          candidate.auto_graduated_at = new Date().toISOString();
          autoGraduated.push(candidate.candidate_id);
          atom.activity_tier = 'graduated';
        }
      }
    }

    if (toUpdate.length) {
      await client.from('thea_atoms').upsert(toUpdate, { onConflict: 'id' });
    }
  }

  // ── 3. Write new candidates to thea_brain_candidates
  if (newCandidates.length) {
    const rows = newCandidates.map(c => ({
      id: c.candidate_id, data: c, _ts: new Date().toISOString()
    }));
    await client.from('thea_brain_candidates').upsert(rows, { onConflict: 'id' });
  }

  const elapsed = Date.now() - t0;
  const result = {
    run_id: runId,
    status: 'ok',
    atoms_reviewed: reviewIds.length,
    tier_promotions: tierChanges,
    new_candidates: newCandidates.length,
    auto_graduated: autoGraduated.length,
    elapsed_ms: elapsed,
  };
  _log('Graduation cycle done · ' + JSON.stringify(tierChanges) + ' · ' + newCandidates.length + ' candidates · ' + elapsed + 'ms');
  await _logCycle({ cycle: 'graduation', ...result });
  return result;
}

/**
 * Propose a CB/MB candidate entry from an atom.
 * Maps atom shape to the target brain's slot schema.
 */
function _proposeCandidate(atom, citations, survived) {
  const candId = 'cand_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const disc = atom.discipline || 'unclassified';

  // ── Decide target brain + slot based on atom type and discipline
  let targetBrain = 'cb', targetSlot = 'nudges';  // default
  if (atom.type === 'cross-region-synthesis' || atom.type === 'synthesised-insight') {
    // Cross-region / synthesised insights → nudges by default
    targetBrain = 'cb'; targetSlot = 'nudges';
  }
  if (atom.type === 'ps-resolution' || (atom.tags || []).includes('ps')) {
    targetBrain = 'cb'; targetSlot = 'ps_resolutions';
  }
  if (atom.type === 'mission' || (atom.tags || []).includes('mission')) {
    targetBrain = 'cb'; targetSlot = 'missions';
  }
  // MB targets (math content)
  const mbDisciplines = ['mathematics', 'analytic_number_theory', 'algebraic_topology',
                         'computational_complexity', 'mathematical_logic', 'category_theory',
                         'glyph_math', 'information_theory'];
  if (mbDisciplines.includes(disc)) {
    targetBrain = 'mb';
    targetSlot = (atom.type === 'cross-region-synthesis' || atom.type === 'synthesised-insight')
      ? 'cleared_paths' : 'fog_states';
  }

  // ── Build proposed CB/MB-format entry (schema depends on slot)
  let proposedEntry;
  if (targetBrain === 'cb' && targetSlot === 'nudges') {
    proposedEntry = {
      module_id: 'nudges.proposed_' + candId.slice(-8),
      name: (atom.claim || '').slice(0, 60),
      category: disc,
      what: (atom.claim || '').slice(0, 300),
      why_matters: 'Emerged from ' + citations + ' routing citations and ' + survived + ' synthesis cycles',
      example: '',
      best_stage: 'consideration',
      best_channel: 'general',
      priority: Math.min(9, Math.round(3 + citations / 5)),
      funnel_stage: 'consideration',
      channel: 'general',
      use_case: 'Auto-proposed from Thea autonomous synthesis',
    };
  } else if (targetBrain === 'cb' && targetSlot === 'ps_resolutions') {
    proposedEntry = {
      ps_id: 'PS-proposed-' + candId.slice(-6),
      name: (atom.claim || '').slice(0, 80),
      resolution: (atom.claim || '').slice(0, 400),
      category: disc,
      confidence: atom.confidence,
    };
  } else if (targetBrain === 'cb' && targetSlot === 'missions') {
    proposedEntry = {
      mission_id: 'SM-proposed-' + candId.slice(-6),
      name: (atom.claim || '').slice(0, 80),
      objective: (atom.claim || '').slice(0, 300),
      category: disc,
      why: 'Proposed from ' + citations + ' routing citations',
    };
  } else if (targetBrain === 'mb' && targetSlot === 'cleared_paths') {
    proposedEntry = {
      id: 'clear-proposed-' + candId.slice(-6),
      n: (atom.claim || '').slice(0, 80),
      domain: disc,
      gamma_clear: true,
      result: (atom.claim || '').slice(0, 400),
      established_by: 'thea-synthesis',
    };
  } else {  // MB fog_states
    proposedEntry = {
      id: 'fog-proposed-' + candId.slice(-6),
      n: (atom.claim || '').slice(0, 80),
      domain: disc,
      fog_depth: 'moderate',
      open_boundary: (atom.claim || '').slice(0, 400),
      gamma_fog: true,
    };
  }

  // Quality score — higher citations + higher confidence → higher score
  const qualityScore = +((citations / 50) * 0.4 + (survived / 10) * 0.15 + atom.confidence * 0.45).toFixed(3);

  return {
    candidate_id: candId,
    source_type: atom.type === 'cross-region-synthesis' ? 'synthesis' : 'atom',
    source_id: atom.id,
    target_brain: targetBrain,
    target_slot: targetSlot,
    promotion_reason: 'cited ' + citations + 'x · survived ' + survived + ' cycles · confidence ' + atom.confidence,
    quality_score: qualityScore,
    citation_count: citations,
    survived_cycles: survived,
    source_discipline: disc,
    proposed_entry: proposedEntry,
    status: 'pending',
    reviewed_at: null,
    reviewed_by: null,
    ts: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE B — CB RE-INGESTION WITH FULL METADATA PRESERVATION
// ═══════════════════════════════════════════════════════════════════════════
// Rescues the 2,920 disciplines + 2,790 categories + funnel_stage + module_id
// that current theasups CB→atom conversion discards. Reads CB chunks from
// thea_brains (base64 JSON), reconstructs arrays, builds rich atoms with every
// CB field preserved under cb_* prefix. Upserts to thea_atoms.
//
// Non-destructive: new atoms have stable IDs like 'cb_nudge_anchoring_v1_0001'.
// Old bare cb:mission/cb:ps atoms stay until you explicitly clean them up via
// the SQL in the deployment guide.

function _cleanSlug(s, max) {
  max = max || 40;
  return String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);
}

function _buildCBAtom(kind, item) {
  if (!item || typeof item !== 'object') return null;

  // ── Build claim text — concatenate the meaningful textual fields for each kind
  let claim = '';
  if (kind === 'nudge') {
    const parts = [];
    if (item.name) parts.push(item.name);
    if (item.what) parts.push(item.what);
    if (item.why_matters) parts.push('— ' + item.why_matters);
    if (item.example) parts.push('e.g. ' + item.example);
    claim = parts.join(' · ').slice(0, 500);
  } else if (kind === 'ps') {
    const parts = [];
    if (item.name || item.title) parts.push(item.name || item.title);
    const body = item.resolution || item.content || item.description || item.text || item.ps_resolution;
    if (body) parts.push(body);
    claim = parts.join(': ').slice(0, 500);
  } else if (kind === 'mission') {
    const parts = [];
    if (item.name || item.mission_name) parts.push(item.name || item.mission_name);
    const body = item.objective || item.content || item.description || item.mission || item.raw_text;
    if (body) parts.push(body);
    claim = parts.join(' — ').slice(0, 500);
  } else if (kind === 'shopper') {
    const parts = [];
    if (item.name || item.shopper_type || item.type) parts.push(item.name || item.shopper_type || item.type);
    const body = item.description || item.characteristics || item.word_list || item.variables;
    if (body) parts.push(typeof body === 'string' ? body : JSON.stringify(body).slice(0, 300));
    claim = parts.join(': ').slice(0, 500);
  } else if (kind === 'emotion') {
    const parts = [];
    if (item.name || item.emotion) parts.push(item.name || item.emotion);
    const body = item.description || item.trigger || item.meaning;
    if (body) parts.push(body);
    claim = parts.join(': ').slice(0, 500);
  } else if (kind === 'hype') {
    const parts = [];
    if (item.name || item.title || item.hype_type) parts.push(item.name || item.title || item.hype_type);
    const body = item.description || item.mechanism || item.what;
    if (body) parts.push(body);
    claim = parts.join(': ').slice(0, 500);
  } else if (kind === 'ps_model') {
    const parts = [];
    if (item.name || item.discipline) parts.push(item.name || item.discipline);
    const body = item.description || item.approach || item.content;
    if (body) parts.push(body);
    claim = parts.join(': ').slice(0, 500);
  }

  if (!claim || claim.length < 15) return null;

  // ── Stable ID derived from module_id / name
  const idBase = _cleanSlug(
    item.module_id || item.id || item.ps_id || item.mission_id || item.name ||
    item.shopper_type || item.emotion || item.discipline || '',
    60
  ) || 'auto_' + Math.random().toString(36).slice(2, 10);
  const id = 'cb_' + kind + '_' + idBase;

  // ── Tags — include category, discipline, funnel_stage, channel
  const tags = ['cb', kind];
  if (item.category)     tags.push(_cleanSlug(item.category));
  if (item.discipline)   {
    const d = _cleanSlug(item.discipline);
    if (d && d.length > 2 && d.length < 40) tags.push(d);
  }
  if (item.funnel_stage) tags.push('stage_' + _cleanSlug(item.funnel_stage, 20));
  if (item.channel)      tags.push('channel_' + _cleanSlug(item.channel, 20));
  if (item.best_stage)   tags.push('best_' + _cleanSlug(item.best_stage, 20));

  const atom = {
    id,
    claim,
    source: 'cb:' + kind,
    type: 'cb-' + kind,
    tags: tags.filter((t, i) => tags.indexOf(t) === i).slice(0, 12),  // dedupe, cap
    confidence: 0.95,                      // CB is axiom-grade
    // ── category drives discipline (via metadata-first classifier)
    category: item.category || null,
    // ── ALL CB fields preserved under cb_* prefix for routable metadata
    cb_module_id:    item.module_id || null,
    cb_discipline:   item.discipline || null,
    cb_category:     item.category || null,
    cb_name:         item.name || null,
    cb_what:         item.what || null,
    cb_why_matters:  item.why_matters || null,
    cb_why_unknown:  item.why_unknown || null,
    cb_example:      item.example || null,
    cb_risk:         item.risk || null,
    cb_funnel_stage: item.funnel_stage || null,
    cb_channel:      item.channel || null,
    cb_best_stage:   item.best_stage || null,
    cb_best_channel: item.best_channel || null,
    cb_priority:     item.priority || null,
    cb_use_case:     item.use_case || null,
    cb_objective:    item.objective || null,
    cb_resolution:   item.resolution || null,
    cb_kind:         kind,
    ts: Date.now(),
  };

  // Compute 10D coords + real discipline via brain-core
  // (metadata-first classifier picks up atom.category for rich disciplinary routing)
  atom.coords_v2 = computeCoords(atom);
  atom.discipline = classifyDiscipline(atom);

  return atom;
}

/**
 * Stage B — CB Re-ingestion
 * Reads chunked CB from thea_brains, reconstructs arrays, builds rich atoms
 * with every CB metadata field preserved. Upserts to thea_atoms.
 */
async function runCBReingestion(options) {
  options = options || {};
  const dryRun        = options.dry_run === true;
  const sources       = options.sources || ['missions', 'ps', 'nudges', 'shoppers', 'emotions', 'hype', 'ps_model'];
  const maxPerKind    = options.max_per_kind || 0;  // 0 = no cap

  const runId = 'cbreingest_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const t0 = Date.now();
  _log('CB re-ingestion start · run=' + runId + ' · dryRun=' + dryRun);
  const client = await _getSupaClient();

  // ── 1. Fetch all brain_cb_* chunks
  const { data: chunks, error } = await client.from('thea_brains')
    .select('id, data').like('id', 'brain_cb_%');
  if (error) return { status: 'failed', error: 'chunk_fetch: ' + error.message, run_id: runId };
  if (!chunks || !chunks.length) {
    return { status: 'failed', error: 'no CB chunks found in thea_brains (expected ids like brain_cb_missions_0)', run_id: runId };
  }
  _log('CB re-ingestion · ' + chunks.length + ' chunks found');

  // ── 2. Decode chunks and reassemble arrays
  // Node-only: uses Buffer. This function should not be called from browser anyway.
  const b64decode = (s) => {
    if (typeof Buffer !== 'undefined') return Buffer.from(s, 'base64').toString('utf8');
    if (typeof atob !== 'undefined') return decodeURIComponent(escape(atob(s)));
    throw new Error('no base64 decoder available');
  };

  let missions = [], ps = [], nudges = [];
  let shoppers = [], emotions = [], hype = [], ps_model = [];
  for (const c of chunks) {
    const d = c.data || {};
    const b64 = d.b64;
    if (!b64) continue;
    try {
      const json = JSON.parse(b64decode(b64));
      if (c.id === 'brain_cb_meta') {
        shoppers = Array.isArray(json.shoppers) ? json.shoppers : (json.shoppingVars || []);
        emotions = Array.isArray(json.emotions) ? json.emotions : [];
        hype     = Array.isArray(json.hype) ? json.hype : [];
        ps_model = Array.isArray(json.psModel) ? json.psModel : [];
      }
      else if (c.id.startsWith('brain_cb_missions_')) missions = missions.concat(Array.isArray(json) ? json : []);
      else if (c.id.startsWith('brain_cb_ps_'))       ps       = ps.concat(Array.isArray(json) ? json : []);
      else if (c.id.startsWith('brain_cb_nudges_'))   nudges   = nudges.concat(Array.isArray(json) ? json : []);
    } catch (e) { _log('CB chunk parse error · ' + c.id + ' · ' + e.message); }
  }

  const breakdown = {
    missions: missions.length, ps: ps.length, nudges: nudges.length,
    shoppers: shoppers.length, emotions: emotions.length, hype: hype.length,
    ps_model: ps_model.length,
  };
  _log('CB re-ingestion · loaded ' + JSON.stringify(breakdown));

  // ── 3. Build rich atoms for each item
  const allAtoms = [];
  const addFrom = (arr, kind) => {
    if (!sources.includes(kind)) return;
    const take = maxPerKind > 0 ? arr.slice(0, maxPerKind) : arr;
    for (const item of take) {
      const atom = _buildCBAtom(kind, item);
      if (atom) allAtoms.push(atom);
    }
  };
  addFrom(nudges,   'nudge');
  addFrom(ps,       'ps');
  addFrom(missions, 'mission');
  addFrom(shoppers, 'shopper');
  addFrom(emotions, 'emotion');
  addFrom(hype,     'hype');
  addFrom(ps_model, 'ps_model');

  // Dedupe by ID (collisions possible if items share module_id)
  const byId = new Map();
  for (const a of allAtoms) byId.set(a.id, a);
  const uniqueAtoms = [...byId.values()];

  // ── 4. Discipline distribution preview (before write, for safety)
  const discSample = {};
  for (const a of uniqueAtoms) {
    discSample[a.discipline] = (discSample[a.discipline] || 0) + 1;
  }
  const topDisciplines = Object.entries(discSample).sort((a, b) => b[1] - a[1]).slice(0, 15);
  _log('CB re-ingestion · ' + uniqueAtoms.length + ' atoms built · top disciplines: ' +
       topDisciplines.map(([d, n]) => d + '(' + n + ')').join(', '));

  // ── 5. If dry run, return plan without writing
  if (dryRun) {
    return {
      status: 'ok',
      dry_run: true,
      run_id: runId,
      source_chunks: chunks.length,
      source_breakdown: breakdown,
      atoms_built: uniqueAtoms.length,
      top_disciplines: Object.fromEntries(topDisciplines),
      sample_atoms: uniqueAtoms.slice(0, 3).map(a => ({
        id: a.id,
        claim_preview: a.claim.slice(0, 120),
        discipline: a.discipline,
        category: a.category,
        cb_discipline: a.cb_discipline,
        tags: a.tags,
      })),
      elapsed_ms: Date.now() - t0,
    };
  }

  // ── 6. Upsert to thea_atoms in batches
  let upserted = 0, errors = 0;
  for (let i = 0; i < uniqueAtoms.length; i += 100) {
    const batch = uniqueAtoms.slice(i, i + 100).map(a => ({
      id: a.id, data: a, _ts: new Date().toISOString()
    }));
    try {
      const { error: upErr } = await client.from('thea_atoms').upsert(batch, { onConflict: 'id' });
      if (upErr) { errors++; _log('CB upsert batch error: ' + upErr.message); }
      else upserted += batch.length;
    } catch (e) { errors++; _log('CB upsert exception: ' + e.message); }
    if (IS_NODE && i % 500 === 0) await new Promise(r => setTimeout(r, 50));  // light throttle
  }

  const elapsed = Date.now() - t0;
  const result = {
    status: 'ok',
    run_id: runId,
    source_chunks: chunks.length,
    source_breakdown: breakdown,
    atoms_built: uniqueAtoms.length,
    atoms_upserted: upserted,
    errors,
    top_disciplines: Object.fromEntries(topDisciplines),
    elapsed_ms: elapsed,
  };
  _log('CB re-ingestion done · ' + upserted + ' atoms · ' + elapsed + 'ms');
  await _logCycle({ cycle: 'cb_reingest', ...result });
  return result;
}

async function rehydrateAutoBuildState() {
  if (IS_NODE) return;
  try {
    const client = await _getSupaClient();
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    const { data, error } = await client.from('thea_autonomous_builds')
      .select('id, data, _ts').gte('_ts', dayAgo)
      .order('_ts', { ascending: false }).limit(200);
    if (error || !data) return;
    if (!window.AUTO_BUILD_STATE) return;

    const rebuilt = [];
    let consecFail = 0, breakerTrip = null;
    const oldestFirst = [...data].reverse();
    for (const row of oldestFirst) {
      const rec = row.data || {};
      const ts = new Date(row._ts).getTime();
      rebuilt.push({ buildId: row.id, ts, kind: rec.build_kind || 'unknown', status: rec.status || 'unknown' });
      if (rec.status === 'failed') consecFail++;
      else if (rec.status === 'deployed') consecFail = 0;
    }
    if (consecFail >= 5) {
      const lastFailure = data.find(r => (r.data || {}).status === 'failed');
      if (lastFailure) {
        const failTs = new Date(lastFailure._ts).getTime();
        const cooldown = window.AUTO_BUILD_CONFIG?.breaker_cooldown_ms || 1800000;
        if (Date.now() - failTs < cooldown) breakerTrip = failTs;
      }
    }
    const staleThreshold = Date.now() - 1800000;
    const stale = data.filter(r => {
      const rec = r.data || {};
      return rec.status === 'in_progress' && new Date(r._ts).getTime() < staleThreshold;
    });
    for (const row of stale) {
      const rec = row.data || {};
      rec.status = 'abandoned';
      rec.execution_chain = rec.execution_chain || [];
      rec.execution_chain.push({ step: 'abandoned_on_boot', status: 'done', ts: new Date().toISOString() });
      try {
        await client.from('thea_autonomous_builds')
          .update({ data: rec, _ts: new Date().toISOString() }).eq('id', row.id);
      } catch(e) {}
    }
    window.AUTO_BUILD_STATE.recentBuilds = rebuilt;
    window.AUTO_BUILD_STATE.consecutiveFailures = consecFail;
    window.AUTO_BUILD_STATE.breakerTrippedAt = breakerTrip;
    _log('Rehydrated AUTO_BUILD_STATE — ' + rebuilt.length + ' recent · '
         + consecFail + ' fail · ' + (breakerTrip ? 'BREAKER OPEN' : 'clear')
         + (stale.length ? ' · ' + stale.length + ' stale→abandoned' : ''));
  } catch(e) { console.warn('[brain-core] rehydrate failed:', e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

const _api = {
  computeCoords, classifyDiscipline, enrichAtom, registerDiscipline,
  rebuildBrainIndex, enrichAtomCoords,
  routeQuery, nearestAtoms,
  runSynthesisCycle, runDiaryRollup, runBrainGraduation,
  runCBReingestion,
  rehydrateAutoBuildState,
  NUMERIC_DIMS, DISCIPLINE_KEYWORDS, GRADUATION_TIERS, TIER_ORDER,
  _version: '2.8-stage7',
};

if (IS_NODE) {
  module.exports = _api;
} else {
  window.brainCore = _api;
  window.rehydrateAutoBuildState = rehydrateAutoBuildState;
  console.log('⬡ brain-core.js loaded (v2.8-stage7) — 10D w/TIME · routing · synthesis · diary · graduation · CB re-ingestion');
}
