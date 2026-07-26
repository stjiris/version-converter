/**
 * In-place backfill: re-derive Show/Index of the controlled fields
 * (Decisão, Meio Processual, Relator Nome Profissional, Votação) from their raw
 * Original values using the canonical lists, while leaving Original untouched.
 *
 * Safe to run repeatedly (idempotent). Does NOT touch HASH/UUID: the only
 * controlled field that feeds the HASH is "Meio Processual", and its HASH input
 * is the unchanged Original, so document identity is stable.
 *
 * Run after the shared package ships with populated canonical lists:
 *   ES_URL=... ES_USER=... ES_PASS=... npx ts-node src/converters/normalize-controlled-fields.ts
 */
import { client } from "../util/client";
import {
    JurisprudenciaVersion,
    ControlledFields,
    matchCanonical,
    parseVotacao,
    GenericField,
} from "jurisprudencia-document-13";

// Re-derive Show + Index from the raw Original values. Votação is parametrized
// (Show carries counts, Index is the count-free category); every other field
// uses the same normalized value for both Show and Index.
function deriveShowIndex(field: typeof ControlledFields[number], original: string[]) {
    if (field === "Votação") {
        const parsed = original.map(v => parseVotacao(v));
        return {
            show: parsed.map(p => p.show),
            index: parsed.map(p => (p.matched ? p.category : p.show)),
            matchedCount: parsed.filter(p => p.matched).length,
        };
    }
    const results = original.map(v => matchCanonical(field, v));
    const norm = results.map(r => r.value);
    return { show: norm, index: norm, matchedCount: results.filter(r => r.matched).length };
}

function normalizeField(field: typeof ControlledFields[number], value: GenericField | undefined | null) {
    if (!value || !Array.isArray(value.Original) || value.Original.length === 0) return null;
    const { show, index, matchedCount } = deriveShowIndex(field, value.Original);
    const total = value.Original.length;
    const same = (a: string[] | undefined, b: string[]) =>
        Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
    const changed = !(same(value.Show, show) && same(value.Index, index));
    return { changed, show, index, matchedCount, total };
}

async function backfill(batchSize = 500) {
    const exists = await client.indices.exists({ index: JurisprudenciaVersion }).catch(() => false);
    if (!exists) throw new Error(`Index ${JurisprudenciaVersion} does not exist.`);

    const resp = await client.search<any>({
        index: JurisprudenciaVersion,
        scroll: "2m",
        size: batchSize,
        _source: ControlledFields as unknown as string[],
        body: { query: { match_all: {} } },
    });

    let scrollId: string | undefined = (resp as any)._scroll_id;
    let hits = (resp as any).hits?.hits || [];
    const totalSeen = (resp as any).hits?.total?.value ?? hits.length;

    let docsUpdated = 0;
    let docsSeen = 0;
    const matched: Record<string, number> = {};
    const total: Record<string, number> = {};
    for (const f of ControlledFields) { matched[f] = 0; total[f] = 0; }

    console.log(`Backfilling controlled fields on ${JurisprudenciaVersion}: ${totalSeen} docs, batches of ${batchSize}...`);

    while (hits.length) {
        const bulkOps: any[] = [];

        for (const hit of hits) {
            docsSeen++;
            const src = hit._source || {};
            const docPatch: Record<string, GenericField> = {};
            for (const field of ControlledFields) {
                const res = normalizeField(field, src[field]);
                if (!res) continue;
                matched[field] += res.matchedCount;
                total[field] += res.total;
                if (res.changed) {
                    docPatch[field] = { Original: src[field].Original, Show: res.show, Index: res.index };
                }
            }
            if (Object.keys(docPatch).length > 0) {
                bulkOps.push({ update: { _index: JurisprudenciaVersion, _id: hit._id } });
                bulkOps.push({ doc: docPatch });
            }
        }

        if (bulkOps.length) {
            const bulkResp = await client.bulk({ refresh: false, operations: bulkOps });
            if (bulkResp.errors) {
                for (const item of bulkResp.items || []) {
                    const action = item.update;
                    if (action && action.error) console.error("Bulk update error:", action.error);
                }
                throw new Error("Bulk update completed with errors (see logs).");
            }
            docsUpdated += bulkOps.length / 2;
        }
        console.log(`Seen ${docsSeen} / ${totalSeen} (updated ${docsUpdated})`);

        if (!scrollId) break;
        const next = await client.scroll({ scroll_id: scrollId, scroll: "2m" });
        scrollId = (next as any)._scroll_id;
        hits = (next as any).hits?.hits || [];
    }

    if (scrollId) {
        try { await client.clearScroll({ scroll_id: scrollId }); } catch { /* ignore */ }
    }

    await client.indices.refresh({ index: JurisprudenciaVersion });

    console.log("\nMatch coverage (canonical hits / total values per field):");
    for (const f of ControlledFields) {
        const pct = total[f] ? ((matched[f] / total[f]) * 100).toFixed(1) : "0.0";
        console.log(`  ${f}: ${matched[f]} / ${total[f]} (${pct}%) — ${total[f] - matched[f]} need manual correction`);
    }
    console.log(`\nDone. Documents updated: ${docsUpdated}.`);
}

backfill(500).catch(err => {
    console.error(err);
    process.exit(1);
});
