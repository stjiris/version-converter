/**
 * Context extraction for the AI/manual review of the controlled-fields mapping
 * (companion to extract-distinct-controlled.ts / apply-controlled-mapping.ts).
 *
 * For every distinct raw `<Field>.Original` value it collects evidence that helps
 * decide the right canonical value:
 *   - which `Index`/`Show` values those docs ALREADY carry (docs corrected by
 *     editors are ground truth: they show what a raw value was decided to mean);
 *   - the `Data` date range of the docs (for Relator, a raw name's activity
 *     window disambiguates between similarly-spelled judges).
 * It also dumps, per field, every existing `Index.raw` value with its own date
 * range, so each canonical-in-use gets an activity window.
 *
 *   INDEX=jurisprudencia.12.0 ES_URL=... ES_USER=... ES_PASS=... \
 *     node dist/converters/extract-controlled-context.js [context_original.csv] [context_index.csv]
 *
 * Outputs:
 *   context_original.csv  field,raw,count,index_values,show_values,date_min,date_max
 *   context_index.csv     field,value,count,date_min,date_max
 * where index_values/show_values are pipe-joined `value(count)` entries, most
 * frequent first, and dates are dd/MM/yyyy (empty when the docs have no Data).
 */
import { writeFileSync } from "fs";
import { client } from "../util/client";
import { JurisprudenciaVersion, ControlledFields } from "jurisprudencia-document-13";

const TERMS_SIZE = 20000; // distinct raw values per field; generous upper bound
const SUB_INDEX_SIZE = 5; // top existing Index values shown per raw value
const SUB_SHOW_SIZE = 3;  // top existing Show values shown per raw value

const INDEX = process.env.INDEX || JurisprudenciaVersion;

function csvCell(s: string | number): string {
    const v = String(s);
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** `value(count)` entries pipe-joined; `|`/`(` inside values are left as-is —
 * the review script splits on `|` between entries, which is unambiguous enough
 * for evidence meant for human/rule inspection. */
function joinBuckets(buckets: { key: string; doc_count: number }[]): string {
    return buckets.map(b => `${b.key}(${b.doc_count})`).join("|");
}

type OriginalRow = {
    field: string; raw: string; count: number;
    indexValues: string; showValues: string;
    dateMin: string; dateMax: string;
};
type IndexRow = { field: string; value: string; count: number; dateMin: string; dateMax: string };

async function contextPerOriginal(field: string): Promise<OriginalRow[]> {
    const resp = await client.search<any>({
        index: INDEX,
        size: 0,
        body: {
            aggs: {
                vals: {
                    terms: { field: `${field}.Original`, size: TERMS_SIZE },
                    aggs: {
                        idx: { terms: { field: `${field}.Index.raw`, size: SUB_INDEX_SIZE } },
                        shw: { terms: { field: `${field}.Show`, size: SUB_SHOW_SIZE } },
                        dmin: { min: { field: "Data", format: "dd/MM/yyyy" } },
                        dmax: { max: { field: "Data", format: "dd/MM/yyyy" } },
                    },
                },
            },
        },
    });
    const agg = (resp as any).aggregations?.vals;
    const sumOther = agg?.sum_other_doc_count ?? 0;
    if (sumOther > 0) {
        console.warn(`  WARNING: ${field} has more than ${TERMS_SIZE} distinct values (` +
            `${sumOther} doc-values not listed). Raise TERMS_SIZE.`);
    }
    return (agg?.buckets ?? []).map((b: any) => ({
        field,
        raw: b.key as string,
        count: b.doc_count as number,
        indexValues: joinBuckets(b.idx?.buckets ?? []),
        showValues: joinBuckets(b.shw?.buckets ?? []),
        dateMin: b.dmin?.value_as_string ?? "",
        dateMax: b.dmax?.value_as_string ?? "",
    }));
}

async function contextPerIndex(field: string): Promise<IndexRow[]> {
    const resp = await client.search<any>({
        index: INDEX,
        size: 0,
        body: {
            aggs: {
                vals: {
                    terms: { field: `${field}.Index.raw`, size: TERMS_SIZE },
                    aggs: {
                        dmin: { min: { field: "Data", format: "dd/MM/yyyy" } },
                        dmax: { max: { field: "Data", format: "dd/MM/yyyy" } },
                    },
                },
            },
        },
    });
    return ((resp as any).aggregations?.vals?.buckets ?? []).map((b: any) => ({
        field,
        value: b.key as string,
        count: b.doc_count as number,
        dateMin: b.dmin?.value_as_string ?? "",
        dateMax: b.dmax?.value_as_string ?? "",
    }));
}

async function main() {
    const outOriginal = process.argv[2] || "context_original.csv";
    const outIndex = process.argv[3] || "context_index.csv";

    const exists = await client.indices.exists({ index: INDEX }).catch(err => {
        throw new Error(`Cannot reach Elasticsearch at ${process.env.ES_URL || "default URL"}: ${err.message}`);
    });
    if (!exists) throw new Error(`Index ${INDEX} does not exist.`);
    console.log(`Reading controlled-field context from ${INDEX}...`);

    const originalRows: OriginalRow[] = [];
    const indexRows: IndexRow[] = [];
    for (const field of ControlledFields) {
        const orig = await contextPerOriginal(field);
        const idx = await contextPerIndex(field);
        originalRows.push(...orig);
        indexRows.push(...idx);
        console.log(`${field}: ${orig.length} distinct Original values, ${idx.length} distinct Index values.`);
    }

    const originalLines = ["field,raw,count,index_values,show_values,date_min,date_max"];
    for (const r of originalRows) {
        originalLines.push([r.field, r.raw, r.count, r.indexValues, r.showValues, r.dateMin, r.dateMax]
            .map(csvCell).join(","));
    }
    writeFileSync(outOriginal, originalLines.join("\r\n") + "\r\n", "utf8");

    const indexLines = ["field,value,count,date_min,date_max"];
    for (const r of indexRows) {
        indexLines.push([r.field, r.value, r.count, r.dateMin, r.dateMax].map(csvCell).join(","));
    }
    writeFileSync(outIndex, indexLines.join("\r\n") + "\r\n", "utf8");

    console.log(`\nWrote ${originalRows.length} rows to ${outOriginal} and ${indexRows.length} rows to ${outIndex}.`);
    console.log(`Feed both to scripts/ai-review-controlled.js together with mapping.csv.`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
