import { client } from "../util/client";
import { JurisprudenciaVersion as JurisprudenciaVersion13 } from "jurisprudencia-document-13";
import { JurisprudenciaDocumentKeys as JurisprudenciaDocumentKeys14, JurisprudenciaVersion as JurisprudenciaVersion14 } from "jurisprudencia-document-14";

const KEYS_INFO_INDEX = "keys-info.0.0";

const KEYS_INFO_MAPPINGS = {
    properties: {
        key: { type: "keyword" },
        name: { type: "keyword" },
        description: { type: "text" },
        active: { type: "boolean" },
        filtersSuggest: { type: "boolean" },
        filtersShow: { type: "boolean" },
        filtersOrder: { type: "float" },
        indicesList: { type: "boolean" },
        indicesGroup: { type: "boolean" },
        documentShow: { type: "boolean" },
        authentication: { type: "boolean" },
        editorEnabled: { type: "boolean" },
        editorSuggestions: { type: "boolean" },
        editorRestricted: { type: "boolean" },
    }
} as const;

async function migrateKeysInfo() {
    const exists = await client.indices.exists({ index: KEYS_INFO_INDEX }).catch(() => false);
    if (!exists) {
        console.log("keys-info.0.0 not found, will be created by juris on first start.");
        return;
    }

    const r = await client.search({ index: KEYS_INFO_INDEX, size: 1000, body: { query: { match_all: {} } } });
    const hits: any[] = (r as any).hits?.hits ?? [];

    const settingsMap = new Map<string, any>();
    for (const hit of hits) {
        const src = hit._source;
        if (!src?.key) continue;
        const existing = settingsMap.get(src.key);
        if (!existing) {
            settingsMap.set(src.key, src);
        } else {
            const countTrue = (o: any) => Object.values(o).filter(v => v === true).length;
            if (countTrue(src) > countTrue(existing)) {
                settingsMap.set(src.key, src);
            }
        }
    }

    console.log(`keys-info.0.0: found ${hits.length} entries (${settingsMap.size} unique keys). Rebuilding for v14...`);

    await client.indices.delete({ index: KEYS_INFO_INDEX });
    await client.indices.create({
        index: KEYS_INFO_INDEX,
        mappings: KEYS_INFO_MAPPINGS as any,
        settings: { number_of_shards: 1, number_of_replicas: 0, refresh_interval: "1s" }
    });

    const operations = JurisprudenciaDocumentKeys14.flatMap((key, i) => {
        const existing = settingsMap.get(key);
        const entry = existing
            ? { ...existing, key }
            : {
                key, name: key, description: "Sem descrição", active: true,
                filtersSuggest: false, filtersShow: false, filtersOrder: i + 1,
                indicesList: false, indicesGroup: false, documentShow: true,
                authentication: false, editorEnabled: false, editorRestricted: false, editorSuggestions: false
            };
        return [{ create: {} }, entry];
    });

    await client.bulk({ index: KEYS_INFO_INDEX, operations: operations as any, refresh: "true" });
    console.log(`keys-info.0.0 rebuilt: ${JurisprudenciaDocumentKeys14.length} v14 keys.`);
}

async function reindex(batchSize = 500) {
    const [existsSrc, existsDst] = await Promise.all([
        client.indices.exists({ index: JurisprudenciaVersion13 }).catch(() => false),
        client.indices.exists({ index: JurisprudenciaVersion14 }).catch(() => false),
    ]);
    if (!existsSrc || !existsDst) {
        throw new Error(`Both indices must exist. src:${JurisprudenciaVersion13}=${existsSrc} dst:${JurisprudenciaVersion14}=${existsDst}`);
    }

    const resp = await client.search({
        index: JurisprudenciaVersion13,
        scroll: "2m",
        size: batchSize,
        body: { query: { match_all: {} } }
    });

    let scrollId: string | undefined = (resp as any)._scroll_id || resp._scroll_id;
    let hits = (resp as any).hits?.hits || [];
    let totalIndexed = 0;
    let totalSeen = (resp as any).hits?.total?.value ?? hits.length;

    console.log(`Found ${totalSeen} documents in ${JurisprudenciaVersion13}, starting migration in batches of ${batchSize}...`);

    while (hits.length) {
        const bulkOps: any[] = [];

        for (const hit of hits) {
            const src = hit._source;
            if (!src) continue;

            bulkOps.push({ index: { _index: JurisprudenciaVersion14, _id: hit._id } });
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

    await client.indices.refresh({ index: JurisprudenciaVersion14 });
    console.log("Migration finished. Total indexed:", totalIndexed);
}

reindex(100).then(() => migrateKeysInfo());
