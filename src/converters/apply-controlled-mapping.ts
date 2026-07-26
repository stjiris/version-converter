/**
 * Step 2 of the distinct-value cleanup of the controlled fields. Takes the CSV
 * produced (and hand-corrected) by `extract-distinct-controlled.ts` and fans each
 * raw->canonical decision back out across every document, in place.
 *
 * For each document and each controlled field, every raw value in `Original` is
 * looked up EXACTLY (as stored) in the table:
 *   - found  -> Show/Index get the corrected canonical value (Votação: Index is
 *               the category, Show carries the counts re-read from the raw text).
 *   - missing (e.g. a value ingested after the extract) -> fall back to the shared
 *               fuzzy matchCanonical / parseVotacao so nothing is left broken.
 * Original is never touched; HASH/UUID are stable (only Show/Index change, and the
 * sole HASH-feeding controlled field, Meio Processual, hashes Original).
 *
 * Idempotent: re-running yields no further changes.
 *
 *   ES_URL=... ES_USER=... ES_PASS=... npx ts-node src/converters/apply-controlled-mapping.ts <mapping.csv> [--dry-run]
 *
 * Writes to `JurisprudenciaVersion` by default; override for the live prod 12.0 index:
 *   INDEX=jurisprudencia.12.0 ES_URL=... npx ts-node src/converters/apply-controlled-mapping.ts mapping.csv --dry-run
 */
import { readFileSync } from "fs";
import { client } from "../util/client";
import {
    JurisprudenciaVersion,
    ControlledFields,
    VotacaoCategories,
    matchCanonical,
    parseVotacao,
    formatVotacaoShow,
    GenericField,
    VotacaoCategory,
} from "jurisprudencia-document-13";

// Index to write. Defaults to the package's current version; set INDEX to target a
// specific index, e.g. the live prod data: INDEX=jurisprudencia.12.0
const INDEX = process.env.INDEX || JurisprudenciaVersion;

// --- minimal RFC-4180 CSV parser (quoted fields, embedded commas/quotes/newlines) ---
function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { cell += '"'; i++; }
                else inQuotes = false;
            } else cell += ch;
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ",") {
            row.push(cell); cell = "";
        } else if (ch === "\n") {
            row.push(cell); cell = "";
            rows.push(row); row = [];
        } else if (ch === "\r") {
            // swallow; handled with the following \n (or as a bare CR)
            if (text[i + 1] !== "\n") { row.push(cell); cell = ""; rows.push(row); row = []; }
        } else {
            cell += ch;
        }
    }
    if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
    return rows;
}

// field -> (exact raw Original value -> corrected canonical value)
type Mapping = Map<string, Map<string, string>>;

function loadMapping(path: string): Mapping {
    const rows = parseCsv(readFileSync(path, "utf8")).filter(r => r.some(c => c.trim() !== ""));
    if (rows.length === 0) throw new Error(`${path} is empty.`);
    const header = rows[0].map(h => h.trim());
    const iField = header.indexOf("field");
    const iRaw = header.indexOf("raw");
    const iCanon = header.indexOf("canonical");
    if (iField < 0 || iRaw < 0 || iCanon < 0) {
        throw new Error(`${path} must have 'field', 'raw' and 'canonical' columns (got: ${header.join(", ")}).`);
    }
    const map: Mapping = new Map(ControlledFields.map(f => [f, new Map<string, string>()]));
    let skipped = 0;
    for (const r of rows.slice(1)) {
        const field = (r[iField] ?? "").trim();
        const raw = r[iRaw] ?? "";
        const canonical = (r[iCanon] ?? "").trim();
        const bucket = map.get(field);
        if (!bucket) { skipped++; continue; }       // unknown field column
        if (canonical === "") continue;              // left blank -> no mapping, fall back at apply time
        bucket.set(raw, canonical);
    }
    if (skipped) console.warn(`Ignored ${skipped} rows with an unrecognized field.`);
    for (const f of ControlledFields) console.log(`  ${f}: ${map.get(f)!.size} mapped raw values`);
    return map;
}

type Stats = { fromTable: number; fallback: number };

// Resolve one raw Original value to its { show, index } for a field, preferring
// the reviewed table and falling back to the shared fuzzy logic.
function resolve(field: typeof ControlledFields[number], raw: string, table: Map<string, string>, stats: Stats): { show: string; index: string } {
    const mapped = table.get(raw);
    if (field === "Votação") {
        const p = parseVotacao(raw);
        if (mapped !== undefined) {
            stats.fromTable++;
            const isCategory = (VotacaoCategories as readonly string[]).includes(mapped);
            const show = isCategory ? formatVotacaoShow(mapped as VotacaoCategory, p.vencidos, p.declaracoes) : mapped;
            return { show, index: mapped };
        }
        stats.fallback++;
        return { show: p.show, index: p.matched ? p.category : p.show };
    }
    if (mapped !== undefined) {
        stats.fromTable++;
        return { show: mapped, index: mapped };
    }
    stats.fallback++;
    const v = matchCanonical(field, raw).value;
    return { show: v, index: v };
}

function sameArr(a: string[] | undefined, b: string[]): boolean {
    return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
}

async function apply(mappingPath: string, dryRun: boolean, batchSize = 500) {
    const exists = await client.indices.exists({ index: INDEX }).catch(() => false);
    if (!exists) throw new Error(`Index ${INDEX} does not exist.`);

    console.log(`Loading mapping from ${mappingPath}...`);
    const mapping = loadMapping(mappingPath);

    const resp = await client.search<any>({
        index: INDEX,
        scroll: "2m",
        size: batchSize,
        _source: ControlledFields as unknown as string[],
        body: { query: { match_all: {} } },
    });

    let scrollId: string | undefined = (resp as any)._scroll_id;
    let hits = (resp as any).hits?.hits || [];
    const totalSeen = (resp as any).hits?.total?.value ?? hits.length;

    const stats: Record<string, Stats> = {};
    for (const f of ControlledFields) stats[f] = { fromTable: 0, fallback: 0 };
    let docsSeen = 0;
    let docsUpdated = 0;

    console.log(`Applying to ${INDEX}: ${totalSeen} docs, batches of ${batchSize}` +
        (dryRun ? " (DRY RUN — no writes)" : "") + "...");

    while (hits.length) {
        const bulkOps: any[] = [];
        for (const hit of hits) {
            docsSeen++;
            const src = hit._source || {};
            const docPatch: Record<string, GenericField> = {};
            for (const field of ControlledFields) {
                const gf = src[field] as GenericField | undefined;
                if (!gf || !Array.isArray(gf.Original) || gf.Original.length === 0) continue;
                const table = mapping.get(field)!;
                const resolved = gf.Original.map(v => resolve(field, v, table, stats[field]));
                const show = resolved.map(r => r.show);
                const index = resolved.map(r => r.index);
                if (!(sameArr(gf.Show, show) && sameArr(gf.Index, index))) {
                    docPatch[field] = { Original: gf.Original, Show: show, Index: index };
                }
            }
            if (Object.keys(docPatch).length > 0) {
                if (!dryRun) {
                    bulkOps.push({ update: { _index: INDEX, _id: hit._id } });
                    bulkOps.push({ doc: docPatch });
                }
                docsUpdated++;
            }
        }

        if (bulkOps.length) {
            const bulkResp = await client.bulk({ refresh: false, operations: bulkOps });
            if (bulkResp.errors) {
                for (const item of bulkResp.items || []) {
                    if (item.update?.error) console.error("Bulk update error:", item.update.error);
                }
                throw new Error("Bulk update completed with errors (see logs).");
            }
        }
        console.log(`Seen ${docsSeen} / ${totalSeen} (${dryRun ? "would update" : "updated"} ${docsUpdated})`);

        if (!scrollId) break;
        const next = await client.scroll({ scroll_id: scrollId, scroll: "2m" });
        scrollId = (next as any)._scroll_id;
        hits = (next as any).hits?.hits || [];
    }

    if (scrollId) { try { await client.clearScroll({ scroll_id: scrollId }); } catch { /* ignore */ } }
    if (!dryRun) await client.indices.refresh({ index: INDEX });

    console.log("\nResolution source per field (table = corrected mapping, fallback = fuzzy on unseen values):");
    for (const f of ControlledFields) {
        console.log(`  ${f}: ${stats[f].fromTable} from table, ${stats[f].fallback} fallback`);
    }
    console.log(`\n${dryRun ? "DRY RUN — would update" : "Done. Documents updated:"} ${docsUpdated}.`);
}

const mappingPath = process.argv.find(a => !a.startsWith("--") && a !== process.argv[0] && a !== process.argv[1]);
const dryRun = process.argv.includes("--dry-run");
if (!mappingPath) {
    console.error("Usage: apply-controlled-mapping.ts <mapping.csv> [--dry-run]");
    process.exit(1);
}
apply(mappingPath, dryRun).catch(err => {
    console.error(err);
    process.exit(1);
});
