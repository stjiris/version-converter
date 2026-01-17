import { client } from "../util/client";
import { waitTask } from "../util/wait-task";
import { JurisprudenciaVersion as JurisprudenciaVersion12 } from "jurisprudencia-document-12";
import { calculateHASH, calculateUUID, JurisprudenciaDocument, JurisprudenciaVersion as JurisprudenciaVersion13 } from "jurisprudencia-document-13";

async function reindexWithUuid(batchSize = 500) {
    const [existsSrc, existsDst] = await Promise.all([
        client.indices.exists({ index: JurisprudenciaVersion12 }).catch(() => false),
        client.indices.exists({ index: JurisprudenciaVersion13 }).catch(() => false),
    ]);
    if (!existsSrc || !existsDst) {
        throw new Error(`Both indices must exist. src:${JurisprudenciaVersion12}=${existsSrc} dst:${JurisprudenciaVersion13}=${existsDst}`);
    }

    const resp = await client.search({
        index: JurisprudenciaVersion12,
        scroll: "2m",
        size: batchSize,
        body: { query: { match_all: {} } }
    });

    let scrollId: string | undefined = (resp as any)._scroll_id || resp._scroll_id;
    let hits = (resp as any).hits?.hits || [];
    let totalIndexed = 0;
    let totalSeen = (resp as any).hits?.total?.value ?? hits.length;

    console.log(`Found ${totalSeen} documents in ${JurisprudenciaVersion12}, starting migration in batches of ${batchSize}...`);

    while (hits.length) {
        const bulkOps: any[] = [];

        for (const hit of hits) {
            const src: JurisprudenciaDocument = hit._source || {};
            if (!src)
                continue;
            const docForHash = {
                Original: src.Original ?? {},
                "Número de Processo": src["Número de Processo"] ?? "",
                Data: src.Data ?? "",
                "Meio Processual": src["Meio Processual"] ?? { Original: [], Index: [], Show: [] },
            };

            const hash = calculateHASH(docForHash);
            const uuid = calculateUUID(hash);

            src.UUID = uuid;
            src.HASH = hash;

            bulkOps.push({ index: { _index: JurisprudenciaVersion13, _id: uuid } });
            bulkOps.push(src);
        }

        if (bulkOps.length) {
            const bulkResp = await client.bulk({ refresh: false, operations: bulkOps });
            if (bulkResp.errors) {
                for (const item of bulkResp.items || []) {
                    const action = item.index || item.create || item.update || item.delete;
                    if (action && action.error) {
                        console.error("Bulk indexing error:", action);
                    }
                }
                throw new Error("Bulk indexing completed with errors (see logs).");
            }
            totalIndexed += hits.length;
            console.log(`Indexed ${totalIndexed} / ${totalSeen}`);
        }

        if (!scrollId) break;
        const next = await client.scroll({
            scroll_id: scrollId,
            scroll: "2m",
        });
        scrollId = (next as any)._scroll_id || next._scroll_id;
        hits = (next as any).hits?.hits || [];
    }

    if (scrollId) {
        try {
            await client.clearScroll({ scroll_id: scrollId });
        } catch (err) {
            // Ignore errors clearing scroll
        }
    }

    await client.indices.refresh({ index: JurisprudenciaVersion13 });
    console.log("Migration finished. Total indexed:", totalIndexed);
}

reindexWithUuid();