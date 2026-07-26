/**
 * Step 1 of the distinct-value cleanup of the controlled fields
 * (Decisão, Meio Processual, Relator Nome Profissional, Votação).
 *
 * Instead of fixing 70k documents one by one, collapse each field onto its
 * DISTINCT raw values via a terms aggregation on `<Field>.Original` (a keyword),
 * fuzzy-suggest the closest canonical value for each, and write a CSV for review.
 * Fuzzy does the first pass ("which one might this be"); you then correct the
 * `canonical` column where the guess is wrong.
 *
 * The reviewed CSV is the input to `apply-controlled-mapping.ts`, which fans the
 * decision back out across every document.
 *
 *   ES_URL=... ES_USER=... ES_PASS=... npx ts-node src/converters/extract-distinct-controlled.ts [out.csv]
 *
 * Reads `JurisprudenciaVersion` by default; override for the live prod 12.0 index:
 *   INDEX=jurisprudencia.12.0 ES_URL=... npx ts-node src/converters/extract-distinct-controlled.ts mapping.csv
 *
 * CSV columns: field,raw,count,auto_matched,score,canonical
 *   - field        controlled field name
 *   - raw          a distinct Original value (exact, as stored)
 *   - count        how many doc-values carry this raw string (review high counts first)
 *   - auto_matched 1 if the fuzzy guess is confident (>= threshold), 0 if it needs you
 *   - score        similarity of the guess to the raw value, 0.00–1.00 (lower = scrutinize)
 *   - canonical    PRE-FILLED with the best fuzzy guess — CORRECT THIS COLUMN where wrong
 *                  (for Votação this is the count-free category / Index value)
 */
import { writeFileSync } from "fs";
import { client } from "../util/client";
import {
    JurisprudenciaVersion,
    ControlledFields,
    CanonicalValues,
    VotacaoCategories,
    foldValue,
    parseVotacao,
} from "jurisprudencia-document-13";

const TERMS_SIZE = 20000; // distinct raw values per field; generous upper bound
const THRESHOLD = 0.85;   // at/above this, the fuzzy guess is treated as confident

// Index to read. Defaults to the package's current version; set INDEX to target a
// specific index, e.g. the live prod data: INDEX=jurisprudencia.12.0
const INDEX = process.env.INDEX || JurisprudenciaVersion;

// --- local fuzzy (closest canonical, regardless of threshold) ----------------
// Kept here so the extract step can show a best-guess hint without changing the
// shared package; mirrors matchCanonical's fold + Levenshtein scoring.

function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    let prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        let curr = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        prev = curr;
    }
    return prev[b.length];
}

function similarity(a: string, b: string): number {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - levenshtein(a, b) / maxLen;
}

/** Closest entry in `candidates` to `raw`, with its score in [0,1]. */
function closest(raw: string, candidates: readonly string[]): { value: string; score: number } {
    const folded = foldValue(raw.trim());
    if (!folded || candidates.length === 0) return { value: "", score: 0 };
    let best = "";
    let bestScore = -1;
    for (const c of candidates) {
        const score = foldValue(c) === folded ? 1 : similarity(foldValue(c), folded);
        if (score > bestScore) { bestScore = score; best = c; }
    }
    return { value: best, score: bestScore < 0 ? 0 : bestScore };
}

function csvCell(s: string | number): string {
    const v = String(s);
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

type Row = { field: string; raw: string; count: number; matched: boolean; score: number; canonical: string };

// Best fuzzy guess for a raw value. For Votação we first try the structural
// parser (which understands counts); if it can't read it, we fuzzy-match against
// the bare category list as a hint.
function suggest(field: typeof ControlledFields[number], raw: string): { matched: boolean; score: number; canonical: string } {
    if (field === "Votação") {
        const p = parseVotacao(raw);
        if (p.matched) return { matched: true, score: 1, canonical: p.category };
        const c = closest(raw, VotacaoCategories);
        return { matched: false, score: c.score, canonical: c.value };
    }
    const c = closest(raw, CanonicalValues[field]);
    return { matched: c.score >= THRESHOLD, score: c.score, canonical: c.value };
}

async function distinctValues(field: string): Promise<{ key: string; count: number }[]> {
    const resp = await client.search<any>({
        index: INDEX,
        size: 0,
        body: { aggs: { vals: { terms: { field: `${field}.Original`, size: TERMS_SIZE } } } },
    });
    const buckets = (resp as any).aggregations?.vals?.buckets ?? [];
    const sumOther = (resp as any).aggregations?.vals?.sum_other_doc_count ?? 0;
    if (sumOther > 0) {
        console.warn(`  WARNING: ${field} has more than ${TERMS_SIZE} distinct values (` +
            `${sumOther} doc-values not listed). Raise TERMS_SIZE.`);
    }
    return buckets.map((b: any) => ({ key: b.key as string, count: b.doc_count as number }));
}

async function main() {
    const out = process.argv[2] || "controlled-fields-mapping.csv";

    const exists = await client.indices.exists({ index: INDEX }).catch(() => false);
    if (!exists) throw new Error(`Index ${INDEX} does not exist.`);
    console.log(`Reading distinct controlled-field values from ${INDEX}...`);

    const rows: Row[] = [];
    for (const field of ControlledFields) {
        const vals = await distinctValues(field);
        let matchedCount = 0;
        for (const { key, count } of vals) {
            const s = suggest(field, key);
            if (s.matched) matchedCount++;
            rows.push({ field, raw: key, count, matched: s.matched, score: s.score, canonical: s.canonical });
        }
        console.log(`${field}: ${vals.length} distinct raw values, ${matchedCount} confident, ` +
            `${vals.length - matchedCount} need review.`);
    }

    // Unmatched first, then by descending count: the low-confidence, high-impact
    // rows float to the top of the CSV where you start correcting.
    rows.sort((a, b) =>
        (Number(a.matched) - Number(b.matched)) ||
        ControlledFields.indexOf(a.field as any) - ControlledFields.indexOf(b.field as any) ||
        (b.count - a.count));

    const lines = ["field,raw,count,auto_matched,score,canonical"];
    for (const r of rows) {
        lines.push([r.field, r.raw, r.count, r.matched ? 1 : 0, r.score.toFixed(2), r.canonical].map(csvCell).join(","));
    }
    writeFileSync(out, lines.join("\r\n") + "\r\n", "utf8");

    const needReview = rows.filter(r => !r.matched).length;
    console.log(`\nWrote ${rows.length} rows to ${out} (${needReview} below threshold — review those first).`);
    console.log(`Correct the 'canonical' column where the fuzzy guess is wrong, then run apply-controlled-mapping.ts.`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
