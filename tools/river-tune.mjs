/**
 * TEMPORARY SCAFFOLDING - delete once the river generator is tuned.
 * Removal checklist: tools/RIVER-LAB.md
 *
 * Turn river ratings into an actionable recommendation.
 *
 *   node tools/river-tune.mjs [--file shots/river-ratings.jsonl] [--top 40]
 *
 * This is deliberately *not* "training a model". With a handful of 1-5 scores
 * per map there is nothing to train: what works is
 *
 *   A. keep the seeds that scored well            (instant, no fitting)
 *   B. see how the score moves with the 6 knobs   (Pearson correlation)
 *   C. copy what the best-rated maps look like
 *   D. say which knob to turn, and which way
 *
 * The threshold for "good" is chosen from the data rather than fixed at 4: if
 * every map you have rated is a 1 or a 2, an absolute threshold leaves the
 * report with nothing to say exactly when you need it most.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RIVER_PARAMS } from '../src/river.js';
import { CONFIG } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const file = path.resolve(root, arg('file', 'shots/river-ratings.jsonl'));
const topN = Number(arg('top', '40'));
const MIN_FOR_FIT = 20;

const KEYS = Object.keys(RIVER_PARAMS);
/** The value a knob has when the lab did not override it. */
const DEFAULT_KNOB = {
  width: () => CONFIG.river.width,
  meander: () => CONFIG.river.meander,
  wiggle: () => CONFIG.river.wiggle,
  braidChance: () => CONFIG.river.braidChance,
  braidCount: () => CONFIG.river.braidCount,
  branchChance: () => CONFIG.river.branchChance,
  confluenceChance: () => CONFIG.river.confluenceChance,
};

// --------------------------------------------------------------------- input
function parseLines(text) {
  const out = [];
  let malformed = 0;
  let noKnobs = 0;
  let partial = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r = null;
    try {
      r = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (!r || typeof r.score !== 'number' || !r.knobs) {
      malformed++;
      continue;
    }
    const have = KEYS.filter((k) => typeof r.knobs[k] === 'number').length;
    if (!have) {
      noKnobs++;
      continue;
    }
    // A knob added after some ratings were made must not throw that history
    // away: keep the row and evaluate each knob only on the rows that have it.
    r.__have = have;
    if (have < KEYS.length) partial++;
    out.push(r);
  }
  return { rows: out, malformed, noKnobs, partial };
}

const text = await readFile(file, 'utf8').catch(() => '');
const { rows, malformed, noKnobs, partial } = parseLines(text);

if (!rows.length) {
  console.log(`没有找到可用的评分数据：${path.relative(root, file)}`);
  if (malformed || noKnobs) {
    console.log(`  （文件里还有 ${malformed} 行损坏、${noKnobs} 行缺少旋钮值，都被跳过了）`);
  }
  console.log('');
  console.log('先跑起来评分台：');
  console.log('  node tools/serve.mjs');
  console.log('  浏览器打开 http://127.0.0.1:8123/tools/river-lab.html');
  console.log('  键盘 1-5 打分（R 换一条）。打 30 条就能看 A，打 150 条以上 B 才有意义。');
  process.exit(0);
}

const scores = rows.map((r) => r.score);
const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
const stdev = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length);

// ------------------------------------------------------- adaptive "good" tier
/**
 * Pick the score that counts as "good" for THIS set of ratings.
 * 4+ is the intent, but if you have not given out enough 4s we fall back to the
 * best tier that still has a usable number of samples.
 */
function pickThreshold() {
  // A fixed, modest sample is enough for a weighted mean. Asking for 20% of the
  // rows meant that on a low-skewed scale (lots of 1s) even 22 four-star
  // ratings were judged "not enough" and the bar kept sliding down.
  const wanted = Math.min(8, Math.max(3, Math.ceil(rows.length * 0.1)));
  // 4 is the intended bar. The fallback walks *down* for a usable sample, never
  // up: searching for the highest tier that has enough samples happily picked 5
  // and then printed "the threshold was lowered to 5", which is nonsense.
  for (const t of [4, 3, 2, 1]) {
    const n = rows.filter((r) => r.score >= t).length;
    if (n >= wanted || t === 1) return { threshold: t, fallback: t !== 4, count: n };
  }
  return { threshold: 1, fallback: true, count: rows.length };
}
const { threshold, fallback, count: goodCount } = pickThreshold();
const good = rows.filter((r) => r.score >= threshold).sort((a, b) => b.score - a.score);
const bad = rows.filter((r) => r.score <= Math.min(2, threshold - 1));

function correlation(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx < 1e-12 || syy < 1e-12) return 0;
  return sxy / Math.sqrt(sxx * syy);
}
const norm = (key, v) => {
  const [lo, hi] = RIVER_PARAMS[key];
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
};

/** Score-weighted mean of each knob among the good maps. */
function whatGoodLooksLike(list) {
  const weights = list.map((r) => Math.max(0.25, r.score - threshold + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const out = {};
  for (const k of KEYS) {
    let acc = 0;
    let wsum = 0;
    list.forEach((r, i) => {
      if (typeof r.knobs[k] !== 'number') return;
      acc += r.knobs[k] * weights[i];
      wsum += weights[i];
    });
    out[k] = wsum > 0 ? acc / wsum : DEFAULT_KNOB[k]();
  }
  return out;
}

const effects = KEYS.map((k) => {
  const usable = rows.filter((row) => typeof row.knobs[k] === 'number');
  return {
    k,
    n: usable.length,
    r: correlation(usable.map((row) => norm(k, row.knobs[k])), usable.map((row) => row.score)),
  };
}).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

// ------------------------------------------------------------------- header
console.log(`评分文件   ${path.relative(root, file)}`);
console.log(`样本       ${rows.length} 条    平均 ${mean.toFixed(2)} 分   标准差 ${stdev.toFixed(2)}`);
if (malformed || noKnobs) {
  console.log(`跳过       ${malformed} 行损坏、${noKnobs} 行完全没有旋钮值`);
}
if (partial) {
  console.log(`部分       ${partial} 行是老数据，缺个别后来才加的旋钮（每个旋钮各按有值的行统计）`);
}
const dist = [1, 2, 3, 4, 5].map((s) => `${s}:${scores.filter((x) => x === s).length}`).join('  ');
console.log(`分布       ${dist}`);
console.log(
  fallback
    ? `“好”的标准 ${threshold} 分（4 分及以上的只有 ${rows.filter((r) => r.score >= 4).length} 条，不够统计，退到 ${threshold} 分）`
    : `“好”的标准 ${threshold} 分    共 ${goodCount} 条 (${((goodCount / rows.length) * 100).toFixed(0)}%)`,
);

if (rows.length < MIN_FOR_FIT) {
  console.log('');
  console.log(`样本偏少（<${MIN_FOR_FIT}），下面的相关系数只能当参考。`);
}
if (stdev < 0.5) {
  console.log('');
  console.log('警告：标准差很小 —— 你几乎给了同一个分数。');
  console.log('      打分要拉开差距（好的给 5、烂的给 1），否则统计不出任何东西。');
}
if (fallback) {
  const fours = rows.filter((r) => r.score >= 4).length;
  console.log('');
  if (fours === 0) {
    console.log('注意：没有任何一条达到 4 分。这说明按你的标准，现在的生成器整体不合格——');
  } else {
    console.log(`注意：4 分及以上只有 ${fours} 条，样本不够，「好」的阈值退到 ${threshold} 分（原本是 4 分）。`);
    console.log('      想让报告更准，就多给几条真正满意的打 4-5 分。');
  }
  console.log('      别只看「好图长什么样」，B 段里的【负】相关才指出「什么让河变差」。');
}

// ------------------------------------------------------------------- notes
const withNotes = rows.filter((r) => typeof r.note === 'string' && r.note.trim());
if (withNotes.length) {
  console.log('');
  console.log(`=== 评语（你手写的原因，共 ${withNotes.length} 条） ===`);
  const show = (list, title) => {
    if (!list.length) return;
    console.log(`  -- ${title} --`);
    for (const r of list) {
      console.log(`  [${r.score}] seed ${r.seed}  ${r.note.trim()}`);
      console.log('        ' + KEYS.map((k) => `${k}=${r.knobs[k].toFixed(2)}`).join(' '));
    }
  };
  show(withNotes.filter((r) => r.score <= Math.min(2, threshold - 1)).slice(-12), `低分（≤${Math.min(2, threshold - 1)}）说了什么`);
  show(withNotes.filter((r) => r.score >= threshold).slice(-12), `高分（≥${threshold}）说了什么`);
  // Group the words themselves: what do people keep complaining about?
  // Chinese has no spaces, so a whitespace split finds almost nothing - count
  // repeated character bigrams inside CJK runs as well as whole latin words.
  const words = new Map();
  const bump = (w, score) => {
    if (w.length < 2) return;
    const e = words.get(w) || { n: 0, sum: 0 };
    e.n += 1;
    e.sum += score;
    words.set(w, e);
  };
  for (const r0 of withNotes) {
    const note = r0.note.trim();
    for (const token of note.split(/[\s,.!?;:，。！？；：、]+/)) {
      if (!token) continue;
      if (/^[\x00-\x7f]+$/.test(token)) {
        bump(token.toLowerCase(), r0.score);
        continue;
      }
      // CJK run: count its 2-character sequences.
      const cjk = token.match(/[\u4e00-\u9fff]+/g) || [];
      for (const run of cjk) {
        // The whole phrase as well as its bigrams, so the de-duplication pass
        // can collapse "太少"/"少且"/"且细" into "太少且细".
        bump(run, r0.score);
        for (let i = 0; i + 2 <= run.length; i++) bump(run.slice(i, i + 2), r0.score);
      }
    }
  }
  let top = [...words.entries()].filter(([, e]) => e.n >= 2).sort((a, b) => b[1].n - a[1].n);
  // Drop bigrams contained in a longer, equally frequent one ("太细" inside "太细了").
  top = top.filter(([w, e]) => !top.some(([o, oe]) => o !== w && o.includes(w) && oe.n >= e.n));
  top = top.slice(0, 8);
  if (top.length) {
    console.log('  -- 反复出现的词（出现次数 / 平均分） --');
    for (const [w, e] of top) console.log(`    ${w.padEnd(10)} ${e.n} 次   平均 ${(e.sum / e.n).toFixed(2)} 分`);
  }
}

// ---------------------------------------------------------------- A. top seeds
console.log('');
console.log(`=== A. 种子池（分数 ≥${threshold}，零拟合直接可用） ===`);
const pool = [];
const seen = new Set();
for (const r of good) {
  if (seen.has(r.seed)) continue;
  seen.add(r.seed);
  pool.push(r);
  if (pool.length >= topN) break;
}
if (!pool.length) {
  console.log('  一条都没有。');
} else {
  console.log(`  取前 ${pool.length} 个：`);
  console.log('  ' + pool.slice(0, 10).map((r) => `${r.seed}(${r.score})`).join(' '));
  const outFile = path.join(root, 'shots', 'river-seeds.jsonl');
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(
    outFile,
    pool.map((r) => JSON.stringify({ seed: r.seed, score: r.score, knobs: r.knobs })).join('\n') + '\n',
    'utf8',
  );
  console.log(`  已写出   ${path.relative(root, outFile)}`);
  console.log('  用法     游戏里直接放这些 seed 就只会出你满意的河。');
}

// ------------------------------------------------------------ B. knob fitting
console.log('');
console.log('=== B. 每个旋钮和分数的关系 ===');
const maxR = Math.max(...effects.map((e) => Math.abs(e.r)), 1e-6);
for (const e of effects) {
  const bar = '█'.repeat(Math.round((Math.abs(e.r) / maxR) * 16));
  const verdict = Math.abs(e.r) < 0.15 ? '（几乎没关系）' : e.r >= 0 ? '越大越好' : '越小越好';
  console.log(
    `  ${e.k.padEnd(17)} ${e.r >= 0 ? '+' : '−'}${(Math.abs(e.r).toFixed(2) + ' ').padStart(5)}${bar.padEnd(17)} ${verdict}  n=${e.n}`,
  );
}
console.log('  （±0.15 以内基本是噪声；|r| > 0.3 才值得动手）');

// ---------------------------------------------------------------- C. targets
console.log('');
if (Math.abs(effects[0].r) < 0.15) {
  // Printing "good maps average width 43" while every knob is noise invites
  // someone to change a number for no reason.
  console.log(`=== C. 分数 ≥${threshold} 的图平均长什么样 ===`);
  console.log('  （B 段显示所有旋钮都和分数无关，所以下面这组数字没有预测力，仅供参考。）');
} else {
  console.log(`=== C. 分数 ≥${threshold} 的图平均长什么样 ===`);
}
const likeGood = whatGoodLooksLike(good);
const suggested = {};
for (const k of KEYS) {
  const [lo, hi] = RIVER_PARAMS[k];
  suggested[k] = Number(Math.max(lo, Math.min(hi, likeGood[k])).toFixed(2));
}
console.log('');
console.log('  旋钮              好图平均   当前值');
for (const k of KEYS) {
  const cur = DEFAULT_KNOB[k]();
  const span = RIVER_PARAMS[k][1] - RIVER_PARAMS[k][0];
  const flag = Math.abs(suggested[k] - cur) > span * 0.15 ? '  ← 差别较大' : '';
  console.log(`  ${k.padEnd(17)} ${String(suggested[k]).padStart(6)}   ${cur.toFixed(2).padStart(6)}${flag}`);
}

// ------------------------------------------------------------ D. what to do
console.log('');
console.log('=== D. 建议 ===');
const strongest = effects[0];
if (Math.abs(strongest.r) < 0.15) {
  console.log('  所有旋钮和你的分数都没什么关系（|r| 全 < 0.15）。');
  console.log('  这通常意味着问题不在这些旋钮上，而在生成器本身的形状；');
  console.log('  把你写过的评语（上面那段）交给 AI 看，通常能直接定位是哪段几何代码。');
} else {
  const [lo, hi] = RIVER_PARAMS[strongest.k];
  const cur = DEFAULT_KNOB[strongest.k]();
  const target = strongest.r >= 0 ? lo + (hi - lo) * 0.8 : lo + (hi - lo) * 0.2;
  console.log(
    `  关系最强的是 ${strongest.k}（r = ${strongest.r.toFixed(2)}）：` +
      (strongest.r < 0 ? '这个值越大，你给的分越低。' : '这个值越大，你给的分越高。'),
  );
  console.log(`  当前 ${cur.toFixed(2)}  →  建议先试 ${target.toFixed(2)}`);
  const tweak = {};
  for (const e of effects) {
    if (Math.abs(e.r) < 0.15) continue;
    const [l, h] = RIVER_PARAMS[e.k];
    const now = DEFAULT_KNOB[e.k]();
    const goal = e.r >= 0 ? l + (h - l) * 0.8 : l + (h - l) * 0.2;
    // Move 60% of the way: a correlation is not a straight line.
    tweak[e.k] = Number((now + (goal - now) * 0.6).toFixed(2));
  }
  console.log('');
  console.log('  一次只改这一个（其余保持现状），贴进 src/config.js 的 river 段：');
  console.log('  ' + JSON.stringify({ [strongest.k]: suggested[strongest.k] }));
  if (Object.keys(tweak).length > 1) {
    console.log('');
    console.log('  想一次多改几个的话，按相关性各推 60%：');
    console.log('  ' + JSON.stringify(tweak));
  }
}
console.log('');
console.log('  改完务必跑：node --test && node tools/balance.mjs 12 4');
console.log('  想先看效果，就在 tools/river-lab.html 点「Play this set」。');
