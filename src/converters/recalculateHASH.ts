import { argv } from "process";
import { client } from "../util/client";
import { createHash } from "crypto";
import { BulkUpdate } from "../util/bulk";
import { format } from "util";
import { JurisprudenciaDocument, JurisprudenciaDocumentHashKey, JurisprudenciaVersion, calculateUUID } from "jurisprudencia-document-12";


client.indices.exists({index: JurisprudenciaVersion}).then(async exists => {
    if( !exists ) throw new Error(`Index "${JurisprudenciaVersion}" doesn't exist`);

    let r = await client.search<JurisprudenciaDocument>({
        index: JurisprudenciaVersion,
        scroll: "2m",
        _source: ["Original", "Número de Processo", "Sumário", "Texto","HASH","UUID"]
    });
    let bk = new BulkUpdate<JurisprudenciaDocument>(client, JurisprudenciaVersion);
    let skips = 0;
    let updates = 0;
    while( r.hits.hits.length > 0 ){
        for( let hit of r.hits.hits ){
            let obj = hit._source;
            if( !obj ) continue;

            let newHash = {
                Original: calculateUUID(obj.Original),
                Processo: calculateUUID(obj["Número de Processo"] || ""),
                Sumário: calculateUUID(obj.Sumário || ""),
                Texto: calculateUUID(obj.Texto || "")
            }
            let newUUID = calculateUUID(newHash, ["Sumário", "Texto", "Processo"]);

            // if any hash is different, update
            if( newUUID !== obj.UUID || newHash.Original !== obj.HASH?.Original || newHash.Processo !== obj.HASH?.Processo || newHash.Sumário !== obj.HASH?.Sumário || newHash.Texto !== obj.HASH?.Texto ){
                await bk.update(hit._id, {
                    HASH: newHash,
                    UUID: newUUID
                })
                updates++;
            }
            else{
                skips++;
            }
        }
        r = await client.scroll({scroll: "2m", scroll_id: r._scroll_id});
    }
    console.log(`+----------------------+`)
    console.log(`| Result  | Value      |`)
    console.log(`+---------+------------+`)
    console.log(`| Skipped | ${skips.toString().padEnd(10, " ")} |`)
    console.log(`| Updated | ${updates.toString().padEnd(10, " ")} |`)
    console.log(`| Total   | ${(skips+updates).toString().padEnd(10, " ")} |`)
    console.log(`+---------+------------+`)
    await bk.close();
})
