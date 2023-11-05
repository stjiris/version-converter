import { argv } from "process";
import { client } from "../util/client";
import { createHash } from "crypto";
import { BulkUpdate } from "../util/bulk";
import { format } from "util";

type JurisprudenciaDocument = {
    Original: string,
    "Número de Processo": string,
    Sumário: string,
    Texto: string,
    HASH: {
        Original: string,
        Processo: string,
        Sumário: string,
        Texto: string
    },
    UUID: string
}



let index = argv[2];
client.indices.exists({index}).then(async exists => {
    if( !exists ) throw new Error(`Index "${index}" doesn't exist`);

    let r = await client.search<JurisprudenciaDocument>({
        index,
        scroll: "2m",
        _source: ["Original", "Número de Processo", "Sumário", "Texto","HASH","UUID"]
    });
    let bk = new BulkUpdate<JurisprudenciaDocument>(client, index);
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
            if( JSON.stringify(newHash, ["Original","Processo","Sumário","Texto"]) !== JSON.stringify(obj.HASH, ["Original","Processo","Sumário","Texto"]) ){
                console.log("+----------------------+-----------------------------+-----------------------------+-----------+")
                console.log(`| ${hit._id} | Current Hash Value          | New Hash Value              | Updated   |`)
                console.log("+----------------------+-----------------------------+-----------------------------+-----------+")
                console.log(`| Original             | ${obj.HASH.Original} | ${newHash.Original} | ${newHash.Original === obj.HASH.Original ? "\x1b[32mNo\x1b[0m       " : "\x1b[31mYes\x1b[0m      "} |`)
                console.log(`| Processo             | ${obj.HASH.Processo} | ${newHash.Processo} | ${newHash.Processo === obj.HASH.Processo ? "\x1b[32mNo\x1b[0m       " : "\x1b[31mYes\x1b[0m      "} |`)
                console.log(`| Sumário              | ${obj.HASH.Sumário} | ${newHash.Sumário} | ${newHash.Sumário === obj.HASH.Sumário ? "\x1b[32mNo\x1b[0m       " : "\x1b[31mYes\x1b[0m      "} |`)
                console.log(`| Texto                | ${obj.HASH.Texto} | ${newHash.Texto} | ${newHash.Texto === obj.HASH.Texto ? "\x1b[32mNo\x1b[0m       " : "\x1b[31mYes\x1b[0m      "} |`)
                console.log(`| UUID                 | ${obj.UUID} | ${newUUID} | ${newUUID === obj.UUID ? "\x1b[32mNo\x1b[0m       " : "\x1b[31mYes\x1b[0m      "} |`)
                console.log("+----------------------+-----------------------------+-----------------------------+-----------+")

                
                await bk.update(hit._id, {
                    HASH: newHash
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
    console.log(`+---------+------------+`)
    await bk.close();
})

function calculateUUID(obj: any, keys?: string[]){
    let str = JSON.stringify(obj, keys);
    let hash = createHash("sha1");
    hash.write(str);
    return hash.digest().toString("base64url");
}