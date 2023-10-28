import { JurisprudenciaDocument, PartialJurisprudenciaDocument, JurisprudenciaVersion, JurisprudenciaDocumentKey, GenericField, JurisprudenciaDocumentGenericKeys } from "jurisprudencia-document-11-with-tipo";
import { client } from "../util/client";
import { BulkUpdate } from "../util/bulk";

client.indices.exists({
    index: JurisprudenciaVersion
}).then(async exists => {
    if(!exists) throw new Error(`Indice: "${JurisprudenciaVersion}" doesn't exist`);

    let r = await client.search<JurisprudenciaDocument>({
        index: JurisprudenciaVersion,
        scroll: "1m",
        _source: ["Original"]
    });
    let datas = {} as Record<string, number>;
    while( r.hits.hits.length > 0 ){
        for( let hit of r.hits.hits ){
            for( let key in hit._source?.Original ){
                if( key.toLocaleLowerCase().startsWith("data") ){
                    if( !(key in datas) ){
                        datas[key] = 0
                    }
                    datas[key]++;
                }
            }
        }
        r = await client.scroll({scroll: "2m", scroll_id: r._scroll_id});
        console.log(datas)
    }
});

// command to run this file:
// node dist/convert testDatas