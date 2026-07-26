// AI-review rule engine for the controlled-fields mapping.
// Reads mapping.csv (never modified) plus the evidence CSVs produced by
// dist/converters/extract-controlled-context.js and writes mapping_aireview.csv
// with a filled `canonical` for EVERY row + `review` flag + `evidence` column.
//
//   node scripts/ai-review-controlled.js [mapping.csv] [context_original.csv] [context_index.csv]
//
// Decision order per row:
//   1. ground truth  — docs already corrected by editors: if the raw value's
//      existing Index values include a canonical, adopt the dominant one;
//   2. field rules   — the regex rules confirmed in review (Decisão outcomes,
//      Votação abbreviations, Meio Processual mappings);
//   3. relator dates — a raw name's activity window (Data range) must overlap
//      the candidate judge's window, otherwise the fuzzy match is rejected;
//   4. fallback      — Meio Processual -> "Outro", everything else -> "Sem
//      informação"; fallbacks stay flagged review=1.
// Also writes suggested-canonicals.md: recurring values with no canonical home,
// i.e. candidates for extending the canonical lists (user decision, not auto-added).
// Pass --no-ground-truth when the target index's Show/Index were already
// rewritten by a previous apply-controlled-mapping run: its Index values then
// just echo that earlier mapping (circular evidence), so only the date windows
// remain trustworthy.
const fs = require("fs");
const path = require("path");
const { CanonicalValues, VotacaoCategories, foldValue } = require("jurisprudencia-document-13");

const args = process.argv.slice(2).filter(a => a !== "--no-ground-truth");
const USE_GROUND_TRUTH = !process.argv.includes("--no-ground-truth");

const ROOT = path.join(__dirname, "..");
const IN_MAPPING = args[0] || path.join(ROOT, "mapping.csv");
const IN_CTX_ORIGINAL = args[1] || path.join(ROOT, "context_original.csv");
const IN_CTX_INDEX = args[2] || path.join(ROOT, "context_index.csv");
const OUT_MAPPING = path.join(ROOT, "mapping_aireview.csv");
const OUT_SUGGESTIONS = path.join(ROOT, "suggested-canonicals.md");

// ---------- CSV ----------
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); cell = ""; rows.push(row); row = []; }
    else if (c === "\r") { if (text[i + 1] !== "\n") { row.push(cell); cell = ""; rows.push(row); row = []; } }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}
function csvCell(s) { const v = String(s); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function readCsvObjects(file) {
  if (!fs.existsSync(file)) return null;
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

// ---------- text helpers ----------
function norm(s) { return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim(); }
function lev(a, b) {
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  let p = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const c = [i];
    for (let j = 1; j <= b.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = c;
  }
  return p[b.length];
}
function sim(a, b) { const m = Math.max(a.length, b.length); return m ? 1 - lev(a, b) / m : 1; }

// ---------- evidence: context CSVs ----------
// "val(12)|other val(3)" -> [{value, count}]; segments without a trailing (n)
// belong to a value that itself contained "|", so merge them back.
function parseValueCounts(s) {
  if (!s) return [];
  const out = [];
  for (const seg of s.split("|")) {
    const m = seg.match(/^(.*)\((\d+)\)$/);
    if (m) out.push({ value: m[1], count: +m[2] });
    else if (out.length) out[out.length - 1].value += "|" + seg;
    else out.push({ value: seg, count: 0 });
  }
  return out;
}
function yearOf(d) { const m = String(d).match(/(\d{4})$/); return m ? +m[1] : null; }

const ctxOriginalRows = readCsvObjects(IN_CTX_ORIGINAL);
const ctxIndexRows = readCsvObjects(IN_CTX_INDEX);
if (!ctxOriginalRows || !ctxIndexRows) {
  console.warn("WARNING: context CSVs not found — running rules-only (no ground truth, no relator dates).");
  console.warn(`  expected: ${IN_CTX_ORIGINAL} and ${IN_CTX_INDEX}`);
}
// field -> raw -> { indexValues:[{value,count}], yearMin, yearMax }
const ctxOriginal = {};
for (const r of ctxOriginalRows || []) {
  (ctxOriginal[r.field] = ctxOriginal[r.field] || {})[r.raw] = {
    indexValues: parseValueCounts(r.index_values),
    yearMin: yearOf(r.date_min), yearMax: yearOf(r.date_max),
  };
}
// Activity window per canonical value: union of the windows of (a) Index values
// and (b) raw Original values that fold to the canonical.
// field -> folded canonical -> {min,max}
const canonicalWindows = {};
function widen(field, folded, yMin, yMax) {
  if (yMin == null && yMax == null) return;
  const byField = canonicalWindows[field] = canonicalWindows[field] || {};
  const w = byField[folded] = byField[folded] || { min: Infinity, max: -Infinity };
  if (yMin != null) w.min = Math.min(w.min, yMin);
  if (yMax != null) w.max = Math.max(w.max, yMax);
}
for (const r of ctxIndexRows || []) widen(r.field, foldValue(r.value), yearOf(r.date_min), yearOf(r.date_max));
for (const r of ctxOriginalRows || []) widen(r.field, foldValue(r.raw), yearOf(r.date_min), yearOf(r.date_max));

const canonicalSets = {};
for (const field of Object.keys(CanonicalValues)) {
  const list = field === "Votação" ? VotacaoCategories : CanonicalValues[field];
  canonicalSets[field] = new Map(list.map(v => [foldValue(v), v]));
}

// Ground truth: dominant existing Index value that is a canonical.
// Trust (review=0) needs >=2 docs — a single edited doc might itself be a mis-edit.
function groundTruth(field, raw) {
  if (!USE_GROUND_TRUTH) return null;
  const ctx = ctxOriginal[field] && ctxOriginal[field][raw];
  if (!ctx) return null;
  const hits = ctx.indexValues
    .map(v => ({ canonical: canonicalSets[field].get(foldValue(v.value)), count: v.count }))
    .filter(v => v.canonical && foldValue(v.canonical) !== foldValue(raw)); // ignore raw==Index (uncleaned docs)
  if (!hits.length) return null;
  hits.sort((a, b) => b.count - a.count);
  const evidence = "gt:" + hits.map(h => `${h.canonical}(${h.count})`).join("|");
  const distinct = new Set(hits.map(h => h.canonical));
  return { canonical: hits[0].canonical, count: hits[0].count, conflicted: distinct.size > 1, evidence };
}

// ---------- Decisão rules (confirmed in review) ----------
const C = {
  GRANT: "Conceder provimento", GRANTP: "Conceder provimento parcialmente", DENY: "Negar provimento",
  NAOCONH: "Não conhecer", INDEF: "Indeferir", DEF: "Deferir", ANULAR: "Anular", CONF: "Confirmar", REVOG: "Revogar",
  REJ: "Rejeitar", ADM: "Admitir", NADM: "Não admitir", DECINC: "Declarar incompetência", DECOMP: "Declarar competência",
  BAIXA: "Ordenar baixa dos autos", EXT: "Julgar extinta a instância", PROSS: "Prosseguir os autos",
  SUSP: "Suspender a instância", FIX: "Fixar jurisprudência", REMET: "Remeter os autos", SEMINFO: "Sem informação",
};
function segOutcome(F) {
  const P = /PARCIAL|EM PARTE/.test(F);
  if (/PEDIDO DE ESCUSA/.test(F)) return "SEMINFO";
  if (/VERIFICADA A OPOSICAO|NAO EXISTIR OPOSICAO|NAO HAVER OPOSICAO|FINDO POR OUTROS|QUESTAO PREVIA|ALTERAD[OA] (O EFEITO|O REGIME|A ESPECIE|A DECISAO|A INDEMNIZACAO|A INCRIMINACAO|A QUALIFICACAO)|REFORMAD[OA] O ACORDAO|ACLARAD|ACLARACAO|DISTRIBU[IÇ]|RESOLVIDO|DECIDIDO (A )?CONHECER|^CONHECER|DECISAO INTERLOCUTORIA|TORNAR PUBLICA|PRONUNCIA|^RELATOR$|^UNANIMIDADE$|^REVISTA$|^RECURSO PENAL$/.test(F)) return "SEMINFO";
  if (/UNIFORMIZ|FIXA[CÇ]?[AÃ]?O? DE JURISPRUDENCIA|FIXAD[OA] (A |DE )?JURISPRUDENCIA|TIRADO ASSENTO/.test(F)) return "FIX";
  if (/ABSOLVICAO DA INSTANCIA|ABSOLVICAO DO REU DA INSTANCIA|INUTILIDADE|IMPOSSIBILIDADE DA LIDE|EXTINCAO|DESISTENCIA|DESERCAO|DESERT|EXTINTA|PRESCRIT|ARQUIVAD/.test(F)) return "EXT";
  if (/SUSPENSAO DA INSTANCIA|SUSPENSA A INSTANCIA/.test(F)) return "SUSP";
  if (/NAO (SE )?(TOMA|TOMAR|TOMOU) CONHECIMENTO|NAO CONHEC|NAO SE CONHECE|DECIDIDO NAO CONHECER|NAO TOMAR CONHECIMENTO|NAO CONHECIDO|NAO CONHECIMENTO/.test(F)) return "NAOCONH";
  if (/NAO AUTORIZAD|RECUSAD[OA] A REVIS|REVIS[AÃ]?O RECUSADA/.test(F)) return "DENY";
  if (/AUTORIZAD.*REVIS|REVIS[AÃ]?O AUTORIZADA/.test(F)) return "GRANT";
  if (/NAO ADMISSAO|NAO ADMITID|NAO ADMITIR|NAO FOI ADMITID|NAO RECEBID|NAO SE ADMITE|NAO RECEBIMENTO/.test(F)) return "NADM";
  if (/ADMITID[OA] A REVISTA|^ADMITIDA|ADMISSAO D[OA] RECURSO/.test(F)) return "ADM";
  if (/INCOMPETENC|DECLARAD[OA] INCOMPETENTE/.test(F)) return "DECINC";
  if (/DECLARACAO DE COMPETENCIA|DECLARAD[OA] COMPETENTE|^COMPETENCIA/.test(F)) return "DECOMP";
  if (/RECLAMACAO (IMPROCEDENTE|INDEFERIDA)|DES[AEN]*TENDIDA A RECLAMACAO|INDEFERIDA RECLAMACAO|DESPACHO RECLAMADO MANTIDO|MANTIDA A DECISAO RECLAMADA|RECUSAD[OA] O PEDIDO/.test(F)) return "INDEF";
  if (/ATENDIDA A RECLAMACAO|RECLAMACAO DEFERIDA|DEFERIDA A RECLAMACAO/.test(F)) return "DEF";
  if (/INDEFER|INDEFEID/.test(F)) return "INDEF";
  if (/DEFER/.test(F)) return "DEF";
  if (/REMESSA|REMETID|REMETER/.test(F)) return "REMET";
  if (/ANULAD|DECLARAD[OA] (A )?NUL(O|A|IDADE)|NULIDADE DO ACORDAO/.test(F)) return "ANULAR";
  if (/CONFIRMAD/.test(F)) return "CONF";
  if (/REVOGAD/.test(F)) return "REVOG";
  if (/REJEITAD|REGEITAD|REJEICAO|REJEITAR|MANIFESTAMENTE INFUNDAD/.test(F)) return "REJ";
  if (/BAIXA|AMPLIAR A MATERIA|REENVIO|REENVIAD|NOVO JULGAMENTO|DILIGENCIA|DETERMINADA A BAIXA/.test(F)) return "BAIXA";
  if (/PROSSEGU/.test(F)) return "PROSS";
  if (/NEGAD|NEGAR|NEGA-SE|NEGOU|DENEGAD|IMPROCED|NAGAD|NEGDA|NEGAG|NEGACAO|NAO PROVID|SEM PROVIMENTO/.test(F)) return "DENY";
  if (/CONCEDID|CONCECID|CONDEDID|CONCEDE-SE|CONCEDIA|CONCEDER|PROVID|DADO PROVIMENTO|PROVIMENTO|PROCEDENT|PROCEDENCIA|JULGADO PARCIALMENTE/.test(F)) return P || /JULGADO PARCIALMENTE/.test(F) ? "GRANTP" : "GRANT";
  return null;
}
function classifyDecisao(raw) {
  const F = norm(raw);
  const segs = F.split(/\.\s*/).map(s => s.trim()).filter(Boolean);
  const known = segs.map(segOutcome).filter(Boolean);
  if (!known.length) return { canonical: "", review: 1, evidence: "" };
  if (segs.length === 1) return { canonical: C[known[0]], review: 0, evidence: "rule" };
  const uniq = [...new Set(known)];
  const sub = uniq.filter(o => !["BAIXA", "SEMINFO", "PROSS"].includes(o));
  const hasG = sub.some(o => o === "GRANT" || o === "GRANTP"), hasD = sub.includes("DENY");
  if ((hasG && hasD) || uniq.includes("GRANTP")) return { canonical: C.GRANTP, review: 1, evidence: "rule:multi-part" };
  if (sub.length) return { canonical: C[sub[0]], review: 1, evidence: "rule:multi-part" };
  return { canonical: C[uniq[0]], review: 1, evidence: "rule:multi-part" };
}

// ---------- Votação rules ----------
function classifyVotacao(raw) {
  const F = norm(raw);
  if (!F || /^[-.\*_\s]+$/.test(F) || /^BMJ|^\?+$|^O+$/.test(F)) return { canonical: "Sem informação", review: 1, evidence: "fallback:junk" };
  const isM = /MAIORIA|MAIROIA|MAORIA|MAIRORIA|MAIORA|POR MAIORIA/.test(F) || sim(F.split(" ")[0], "MAIORIA") >= 0.7;
  if (!isM) {
    if (sim(F, "UNANIMIDADE") >= 0.55 || /UNANIM|UANIM|UANNIM|NANIMIDADE|UNIANIM|UNAMIN|UNANUM|UNUNIM|UNANANIM|UNANIMIZACAO|UNAIMID/.test(F))
      return { canonical: "Unanimidade", review: /COM/.test(F) ? 1 : 0, evidence: "rule" };
    if (/DESEMPATE/.test(F)) return { canonical: "Desempate", review: 1, evidence: "rule" };
    return { canonical: "Sem informação", review: 1, evidence: "fallback" };
  }
  const desemp = /DESEMPATE|VOTO DE QUALIDADE/.test(F);
  const venc = /VOT\.? ?VEN|VOTO?S?\.? ?(DE )?VENC|VENC\.? ?VOT|VOTOS? VENC/.test(F);
  const dec = /DEC\.? ?VOT|DECLARAC/.test(F);
  if (desemp) return { canonical: "Desempate", review: 1, evidence: "rule" };
  if (venc && dec) return { canonical: "Maioria com votos vencidos e declarações de voto", review: 0, evidence: "rule" };
  if (venc) return { canonical: "Maioria com votos vencidos", review: 0, evidence: "rule" };
  if (dec) return { canonical: "Maioria com declarações de voto", review: 0, evidence: "rule" };
  return { canonical: "Maioria simples", review: 0, evidence: "rule" };
}

// ---------- Meio Processual rules ----------
const MP = {
  REVISTA: "Recurso de revista", EXC: "Recurso de revista excecional",
  UNIF: "Recurso extraordinário de uniformização/fixação de jurisprudência", REVISAO: "Recurso extraordinário de revisão",
  SALTUM: "Recurso per saltum", CONTRA: "Recurso de contraordenação", PENAIS: "Recursos penais das decisões do STJ em 1.ª e 2.ª instâncias",
  RCONF: "Reclamação para a conferência", R643: "Reclamação art. 643.º CPC", R405: "Reclamação art. 405.º CPP",
  REFORMA: "Reforma de decisão", REENVIO: "Reenvio prejudicial", HC: "Habeas corpus", RSE: "Revisão de sentença estrangeira",
  CCOMP: "Conflito de competência", CJUR: "Conflito de jurisdição", EXTR: "Extradição", MDE: "Mandado de detenção europeu",
  CSM: "Impugnação das deliberações do CSM", PRES: "Impugnação das decisões do Presidente do STJ",
};
function mpClassify(raw) {
  const F = norm(raw); const w0 = F.split(/[ (.,:]/)[0];
  if (!F || /^[-\/.\s]+$/.test(F)) return { canonical: "Outro", review: 1, orphan: true, evidence: "fallback:junk" };
  if (/HABEAS|HABAEAS|HABES|HEBEAS|HANEAS|HARBEAS|HEBAS|HABEAS COSPUS|HABEAS CORDUS|HABEAS CORPU/.test(F) || sim(F, "HABEAS CORPUS") >= 0.6) return { canonical: MP.HC, review: 0, evidence: "rule" };
  if (/MANDADO DE DETENC|MANADADO|MANDATO DE DETENC|DETENCAO EUROPEU|^M ?\.? ?D ?\.? ?E|MD ?\.? ?D ?\.? ?E/.test(F)) return { canonical: MP.MDE, review: 0, evidence: "rule" };
  if (/EXTRADIC|ESTRADIC/.test(F) || sim(w0, "EXTRADICAO") >= 0.7) return { canonical: MP.EXTR, review: 0, evidence: "rule" };
  if (/REENVIO PREJUDICIAL/.test(F)) return { canonical: MP.REENVIO, review: 0, evidence: "rule" };
  if (/SENTENCA (PENAL )?(ESTRANGEIRA|EXTRANGEIRA|EUROPEIA)|RECONHECIMENTO.*SENTENCA|RECOINHECIEMNTO|RECONHECIMENTOSENTENCA|REVISAO.*SENTENCA|CONFIRMACAO.*SENTENCA|REVISAO E CONFIRMACAO|REVISTA DE SENTENCA|REVISAO DA SENTENCA|REVISAO DE SENTANCA|RECONHECIMENTO E EXECUCAO/.test(F)) return { canonical: MP.RSE, review: 0, evidence: "rule" };
  if (/REC(URSO)?( EXTRAORDINARIO)? DE REVISAO|RERCURSO DE REVISAO|RECURSO DE REVISAO|RECURSO EXTRAORDINARIO DE REVISAO/.test(F)) return { canonical: MP.REVISAO, review: 0, evidence: "rule" };
  if (/(UNIFORMIZ|FIXACAO|FIXA[CÇ]AO|FIX |FIXADA)/.test(F) && /JURIS|JURSI|JURISPR|JURIPR|JURISPRED|JURISPRID/.test(F)) return { canonical: MP.UNIF, review: 0, evidence: "rule" };
  if (/ACORDAO UNIFORMIZADOR|RECURSO UNIFORMIZADOR/.test(F)) return { canonical: MP.UNIF, review: 0, evidence: "rule" };
  if (/REVISTA EXCEC|REVISTA EXCEP|REVISTA ECXEP|REVISTA EXECP|REVISTA AMPLIADA|RECURSO DE REVISTA EXCEC|RECURSO DE REVISTA EXCEP/.test(F)) return { canonical: MP.EXC, review: 0, evidence: "rule" };
  if (/PER SALTUM/.test(F)) return { canonical: MP.SALTUM, review: 0, evidence: "rule" };
  if (/405/.test(F)) return { canonical: MP.R405, review: 0, evidence: "rule" };
  if (/643|6434|ART.*688|688[ºO]? ?CPC/.test(F)) return { canonical: MP.R643, review: /COMERCIO|CONCORRENCIA|PROPRIEDADE|MARITIMO/.test(F) ? 1 : 0, evidence: "rule" };
  if (/RECL.*CONFER|RECLAMACAO PARA A CONFER|^CONFERENCIA|CONFERENCIAS?$|RECL PARA O PRESIDENTE/.test(F)) return { canonical: MP.RCONF, review: 0, evidence: "rule" };
  if (/CONTRAORDENAC|CONTRA ORDENAC|CONTRAORD/.test(F)) return { canonical: MP.CONTRA, review: 0, evidence: "rule" };
  if (/REFORMA DE DECISAO|^REFORMA/.test(F)) return { canonical: MP.REFORMA, review: 0, evidence: "rule" };
  if (/CONFLITO/.test(F)) { if (/COMPETENC/.test(F)) return { canonical: MP.CCOMP, review: 0, evidence: "rule" }; return { canonical: MP.CJUR, review: 0, evidence: "rule" }; }
  if (/\bCSM\b|DELIBERAC.*CSM/.test(F)) return { canonical: MP.CSM, review: 0, evidence: "rule" };
  if (/PRESIDENTE DO STJ|DECISOES DO PRESIDENTE|DECISAO.*PRESIDENTE DO STJ/.test(F)) return { canonical: MP.PRES, review: 0, evidence: "rule" };
  // penal recourse -> the existing specific canonical (incl. common typos)
  if (/PENAL|PENAIS|\bENAL\b|PNEAL|PANAL|PENLA|PEAL\b/.test(F)) return { canonical: MP.PENAIS, review: 0, evidence: "rule" };
  if (/^REVISTA|^A REVISTA|^RECURSO DE REVISTA|REVISTA \(|REVISTA,|REVISTA:|REVISTA\.|REVISTA AMPLIADA/.test(F) || sim(w0, "REVISTA") >= 0.72) return { canonical: MP.REVISTA, review: /COMERCIO|CONCORRENCIA|PROPRIEDADE|MARITIMO|INCIDENTE|AGRAVO|HABILITACAO/.test(F) ? 1 : 0, evidence: "rule" };
  return { canonical: "Outro", review: 1, orphan: true, evidence: "fallback:no-home" };
}

// ---------- Relator: fuzzy shortlist + activity-window check ----------
const RELATOR = "Relator Nome Profissional";
const relatorCanonicals = CanonicalValues[RELATOR].filter(v => v !== "Sem informação");
const relatorFolded = relatorCanonicals.map(v => ({ value: v, folded: foldValue(v) }));
const TOLERANCE_Y = 2; // judges' windows are approximate; allow slack at the edges

// Name-aware similarity: names often differ by dropped given names ("CURA
// MARIANO" = "JOÃO CURA MARIANO") or initials ("M. CARMO SILVA DIAS"), which
// plain Levenshtein undervalues. Compare token sets, letting an initial match
// any token it abbreviates; a name fully contained in the other scores high.
const NAME_STOP = new Set(["de", "da", "do", "dos", "das", "e"]);
function nameTokens(folded) { return folded.split(/[^a-z0-9]+/).filter(t => t && !NAME_STOP.has(t)); }
function tokenMatch(t, u) {
  if (t === u) return 1;
  if (t.length === 1) return u.startsWith(t) ? 0.9 : 0;
  if (u.length === 1) return t.startsWith(u) ? 0.9 : 0;
  return sim(t, u);
}
function coverage(A, B) { return A.reduce((s, t) => s + Math.max(...B.map(u => tokenMatch(t, u))), 0) / A.length; }
function nameSim(a, b) {
  const A = nameTokens(a), B = nameTokens(b);
  if (!A.length || !B.length) return 0;
  const ca = coverage(A, B), cb = coverage(B, A);
  return 0.6 * Math.max(ca, cb) + 0.4 * Math.min(ca, cb);
}

function windowOf(field, canonical) {
  const w = canonicalWindows[field] && canonicalWindows[field][foldValue(canonical)];
  return w && w.min !== Infinity ? w : null;
}
function overlaps(rawW, candW) {
  return rawW.min <= candW.max + TOLERANCE_Y && candW.min - TOLERANCE_Y <= rawW.max;
}
function fmtW(w) { return w ? `${w.min}-${w.max}` : "?"; }

function classifyRelator(raw) {
  // qualifiers like "(RELATOR DE TURNO)" are not part of the name
  const folded = foldValue(raw.replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim());
  // shortlist by the better of edit-distance and token-set similarity
  const scored = relatorFolded
    .map(c => ({ value: c.value, score: c.folded === folded ? 1 : Math.max(sim(c.folded, folded), nameSim(c.folded, folded)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  // near-tie between different judges: never auto-accept, a human must pick
  const ambiguous = scored.length > 1 && scored[0].score < 1 && scored[0].score - scored[1].score < 0.05;
  // a differing surname (last token) is how similar-looking names split into
  // different judges (SÁ PEREIRA vs SÁ FERREIRA) — never auto-accept those
  const rawTokens = nameTokens(folded);
  const surnameOk = c => {
    const candTokens = nameTokens(foldValue(c.value));
    if (!rawTokens.length || !candTokens.length) return false;
    return tokenMatch(rawTokens[rawTokens.length - 1], candTokens[candTokens.length - 1]) >= 0.85;
  };
  // a full name collapsing onto a bare-surname canonical (AMANCIO FERREIRA ->
  // "FERREIRA") is a guess, not a match — a human must confirm it
  const bareSurname = c => nameTokens(foldValue(c.value)).length === 1 && rawTokens.length > 1;
  const trusted = c => !ambiguous && surnameOk(c) && !bareSurname(c);
  const ctx = ctxOriginal[RELATOR] && ctxOriginal[RELATOR][raw];
  const rawW = ctx && ctx.yearMin != null ? { min: ctx.yearMin, max: ctx.yearMax ?? ctx.yearMin } : null;

  const annotate = c => {
    if (!rawW) return { ...c, compatible: null, candW: null };
    const candW = windowOf(RELATOR, c.value);
    return { ...c, candW, compatible: candW ? overlaps(rawW, candW) : null };
  };
  const cands = scored.map(annotate);
  const best = cands[0];
  const datesEv = (c) => rawW && c.candW ? `dates:${fmtW(rawW)}~${fmtW(c.candW)}` : "dates:n/a";

  const why = c => {
    const parts = [`fuzzy:${c.score.toFixed(2)}`, datesEv(c)];
    if (c.compatible === false) parts.push("DATE-CONFLICT");
    if (ambiguous) parts.push(`AMBIGUOUS ~${scored[1].value}(${scored[1].score.toFixed(2)})`);
    else if (!surnameOk(c)) parts.push("SURNAME?");
    else if (bareSurname(c)) parts.push("BARE-SURNAME?");
    return parts.join(" ");
  };

  // strong match: accept unless the dates actively contradict it, a rival is
  // too close, or the surname differs
  if (best.score >= 0.85 && best.compatible !== false)
    return { canonical: best.value, review: trusted(best) ? 0 : 1, score: best.score, evidence: why(best) };
  // otherwise prefer the best date-compatible candidate
  const compatible = cands.find(c => c.compatible === true && c.score >= 0.6);
  if (compatible)
    return { canonical: compatible.value, review: compatible.score >= 0.75 && trusted(compatible) ? 0 : 1, score: compatible.score, evidence: why(compatible) };
  // strong name match but incompatible dates, and nobody better: keep it flagged
  if (best.score >= 0.85)
    return { canonical: best.value, review: 1, score: best.score, evidence: why(best) };
  // no dates to lean on: accept a decent fuzzy match, flagged when weak
  if (best.compatible === null && best.score >= 0.75)
    return { canonical: best.value, review: best.score >= 0.85 && trusted(best) ? 0 : 1, score: best.score, evidence: why(best) };
  return { canonical: "Sem informação", review: 1, score: best.score, evidence: `fallback best:${best.value}(${best.score.toFixed(2)}) ${datesEv(best)}`, unmatched: true };
}

// Flagged best-matches confirmed one-by-one in AI review (2026-07-02): obvious
// misspellings of the SAME judge with compatible date windows, where the
// surname/ambiguity guards were being conservative. Exact raw values.
const RELATOR_CONFIRMED = new Set([
  "ABRANTES GERLADES", "AFONSO DE MELLO", "ALMEIDA DEVESA", "ANTÓNIO GANA",
  "ANTÓNIO LEONES DANTES", "ANTÓNIO JOAQUIM PIRRAÇA", "ARAGÃO SETA", "ARMÉNIO SOTTO MAYOR",
  "CARLOS CALOAS", "CELSO MANTA", "COSTAMORTÁGUA", "GAMA VEIRA", "GARCIA CALEGO",
  "LEMOS TIRUNFANTE", "LOPES DE MELLO", "MELO FRANGO", "MIGUEL CAIRO", "OLIVEIRA MANDES",
  "PINTO BASTO", "PIRES DA GRAGA", "PIRES DA ÇRAÇA", "SILVA FOR", "SOUSA DINIZ",
  "SOUSA MECEDO", "TÁVORA VITOR", "TÁVORA VÍTOR", "SANTOS VITOR", "SIMASSANTOS",
  "NUNO PINTO OLIVIERA", "NELSON BORGES CAMEIRO", "ÓSCAR CARTOLA",
  "NUNO GONAÇLVES", "NUNO GONGAÇVES", "SANTOS CRAVALHO",
  "TERESA DE ALEMIDA (RELATORA DE TURNO)", "JORGE ARCANJO, POR VENCIMENTO",
  "ERNESTO VAZ", "ADELAIDE MAGALHÃES", "PEDRO DE LIMA",
]);

// ---------- run ----------
const mappingRows = parseCsv(fs.readFileSync(IN_MAPPING, "utf8"));
const header = mappingRows[0].map(h => h.trim());
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
for (const col of ["field", "raw", "count", "auto_matched", "score", "canonical"])
  if (!(col in idx)) throw new Error(`${IN_MAPPING} missing column '${col}'`);

const out = [["field", "raw", "count", "auto_matched", "score", "canonical", "review", "evidence"]];
const stats = {}; // field -> {n, gt, rule, fuzzy, fallback, flagged}
const suggestions = { [RELATOR]: [], "Decisão": [], "Meio Processual": [], "Votação": [] };
const relatorUncertain = []; // flagged relator matches: possibly a distinct/missing judge

for (const r of mappingRows.slice(1)) {
  const field = (r[idx.field] || "").trim();
  const raw = r[idx.raw] || "";
  const count = +(r[idx.count] || 0);
  const st = stats[field] = stats[field] || { n: 0, gt: 0, rule: 0, fuzzy: 0, fallback: 0, flagged: 0 };
  st.n++;

  let canonical = "", review = 1, evidence = "", score = r[idx.score] || "";

  // 1) ground truth from already-edited docs
  const gt = groundTruth(field, raw);
  if (gt) {
    canonical = gt.canonical;
    review = gt.conflicted || gt.count < 2 ? 1 : 0;
    evidence = gt.evidence;
    st.gt++;
  } else if (field === "Decisão") {
    const x = classifyDecisao(raw);
    if (x.canonical) { ({ canonical, review, evidence } = x); st.rule++; }
    else { canonical = "Sem informação"; review = 1; evidence = "fallback:unparsed"; st.fallback++; suggestions[field].push({ raw, count }); }
  } else if (field === "Votação") {
    const x = classifyVotacao(raw);
    ({ canonical, review, evidence } = x);
    if (evidence.startsWith("fallback")) { st.fallback++; suggestions[field].push({ raw, count }); } else st.rule++;
  } else if (field === "Meio Processual") {
    const x = mpClassify(raw);
    ({ canonical, review, evidence } = x);
    if (x.orphan) { st.fallback++; suggestions[field].push({ raw, count }); } else st.rule++;
  } else if (field === RELATOR) {
    const x = classifyRelator(raw);
    canonical = x.canonical; review = x.review; evidence = x.evidence; score = x.score.toFixed(2);
    if (review && !x.unmatched && RELATOR_CONFIRMED.has(raw)) { review = 0; evidence += " confirmed:ai-review"; }
    if (x.unmatched) { st.fallback++; suggestions[field].push({ raw, count, evidence: x.evidence }); } else st.fuzzy++;
    if (review && !x.unmatched) relatorUncertain.push({ raw, count, canonical, evidence });
  } else {
    throw new Error(`Unknown field '${field}' in ${IN_MAPPING}`);
  }

  if (review) st.flagged++;
  out.push([field, raw, String(count), r[idx.auto_matched] || "", score, canonical, String(review), evidence]);
}

// ---------- validation ----------
const total = out.length - 1;
if (total !== mappingRows.length - 1) throw new Error(`Row count mismatch: ${mappingRows.length - 1} in, ${total} out`);
const blanks = out.slice(1).filter(r => !r[5].trim());
if (blanks.length) throw new Error(`${blanks.length} blank canonicals remain (first: ${blanks[0][0]} / ${blanks[0][1]})`);
const illegal = out.slice(1).filter(r => !canonicalSets[r[0]].has(foldValue(r[5])));
if (illegal.length) throw new Error(`${illegal.length} canonicals not in list (first: ${illegal[0][0]} -> ${illegal[0][5]})`);

fs.writeFileSync(OUT_MAPPING, out.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n", "utf8");

// ---------- suggestions report ----------
const md = ["# Suggested canonical additions", "",
  "Raw values with no home in the current canonical lists (mapped to the fallback,",
  "flagged `review=1` in mapping_aireview.csv). Recurring ones may deserve a new",
  "canonical value — decide and, if approved, add to `controlled-fields.ts` and re-run.", ""];
for (const field of Object.keys(suggestions)) {
  const list = suggestions[field].sort((a, b) => b.count - a.count);
  const fallback = field === "Meio Processual" ? "Outro" : "Sem informação";
  md.push(`## ${field} — ${list.length} values fell back to "${fallback}"`, "");
  if (!list.length) { md.push("(none)", ""); continue; }
  md.push("| count | raw | notes |", "|---|---|---|");
  for (const s of list.slice(0, 60)) md.push(`| ${s.count} | ${s.raw.replace(/\|/g, "\\|")} | ${(s.evidence || "").replace(/\|/g, "\\|")} |`);
  if (list.length > 60) md.push(`| … | ${list.length - 60} more (see CSV) | |`);
  md.push("");
}
if (relatorUncertain.length) {
  md.push(`## ${RELATOR} — ${relatorUncertain.length} flagged matches (possibly a distinct judge missing from the list)`, "");
  md.push("| count | raw | mapped to | evidence |", "|---|---|---|---|");
  for (const s of relatorUncertain.sort((a, b) => b.count - a.count))
    md.push(`| ${s.count} | ${s.raw.replace(/\|/g, "\\|")} | ${s.canonical} | ${s.evidence.replace(/\|/g, "\\|")} |`);
  md.push("");
}
fs.writeFileSync(OUT_SUGGESTIONS, md.join("\n") + "\n", "utf8");

// ---------- summary ----------
console.log(`Rows: ${total} -> ${OUT_MAPPING}`);
console.log("\nPer field (total / ground-truth / rule / fuzzy / fallback / flagged):");
for (const f of Object.keys(stats)) {
  const s = stats[f];
  console.log(`  ${f}: ${s.n} / ${s.gt} / ${s.rule} / ${s.fuzzy} / ${s.fallback} / ${s.flagged}`);
}
console.log(`\nSuggestions report: ${OUT_SUGGESTIONS}`);
