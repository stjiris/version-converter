import { client } from "../util/client";
import { JurisprudenciaVersion as JurisprudenciaVersion12 } from "jurisprudencia-document-12";
import { calculateHASH, calculateUUID, JurisprudenciaDocument, JurisprudenciaDocumentKeys as JurisprudenciaDocumentKeys13, JurisprudenciaVersion as JurisprudenciaVersion13 } from "jurisprudencia-document-13";

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

    // Fetch all existing entries (backup may have duplicates)
    const r = await client.search({ index: KEYS_INFO_INDEX, size: 1000, body: { query: { match_all: {} } } });
    const hits: any[] = (r as any).hits?.hits ?? [];

    // Build a map: key → best settings (prefer entries with more flags set to true)
    const settingsMap = new Map<string, any>();
    for (const hit of hits) {
        const src = hit._source;
        if (!src?.key) continue;
        const existing = settingsMap.get(src.key);
        if (!existing) {
            settingsMap.set(src.key, src);
        } else {
            // Keep whichever has more "true" boolean flags (i.e. more configured)
            const countTrue = (o: any) => Object.values(o).filter(v => v === true).length;
            if (countTrue(src) > countTrue(existing)) {
                settingsMap.set(src.key, src);
            }
        }
    }

    console.log(`keys-info.0.0: found ${hits.length} entries (${settingsMap.size} unique keys). Rebuilding for v13...`);

    // Delete and recreate the index cleanly
    await client.indices.delete({ index: KEYS_INFO_INDEX });
    await client.indices.create({
        index: KEYS_INFO_INDEX,
        mappings: KEYS_INFO_MAPPINGS as any,
        settings: { number_of_shards: 1, number_of_replicas: 0, refresh_interval: "1s" }
    });

    // Insert exactly one entry per v13 key, preserving existing settings where available
    const operations = JurisprudenciaDocumentKeys13.flatMap((key, i) => {
        const existing = settingsMap.get(key);
        const entry = existing
            ? { ...existing, key }
            : {
                key, name: key, description: "Sem descrição", active: false,
                filtersSuggest: false, filtersShow: false, filtersOrder: i + 1,
                indicesList: false, indicesGroup: false, documentShow: false,
                authentication: false, editorEnabled: false, editorRestricted: false, editorSuggestions: false
            };
        return [{ create: {} }, entry];
    });

    await client.bulk({ index: KEYS_INFO_INDEX, operations: operations as any, refresh: "true" });
    console.log(`keys-info.0.0 rebuilt: ${JurisprudenciaDocumentKeys13.length} v13 keys.`);
}

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
                Original: src.Original,
                "Número de Processo": src["Número de Processo"],
                Data: src.Data,
                "Meio Processual": src["Meio Processual"],
                Texto: src.Texto,
                "Texto Não Anonimizado": src["Texto Não Anonimizado"],
                Sumário: src.Sumário,
                "Sumário Não Anonimizado": src["Sumário Não Anonimizado"],
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

reindexWithUuid(100).then(() => migrateKeysInfo());