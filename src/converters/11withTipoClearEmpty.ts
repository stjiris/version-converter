import { JurisprudenciaDocument, PartialJurisprudenciaDocument, JurisprudenciaVersion, JurisprudenciaDocumentKey, GenericField } from "jurisprudencia-document-11-with-tipo";
import { client } from "../util/client";
import { BulkUpdate } from "../util/bulk";

client.indices.exists({
    index: JurisprudenciaVersion
}).then(async exists => {
    if(!exists) throw new Error(`Indice: "${JurisprudenciaVersion}" doesn't exist`);

    let bup = new BulkUpdate<JurisprudenciaDocument>(client, JurisprudenciaVersion);

    let r = await client.search<JurisprudenciaDocument>({
        index: JurisprudenciaVersion,
        scroll: "2m",
        _source: {
            excludes: ["Original", "HASH","CONTENT","Data"]
        }
    });

    while( r.hits.hits.length > 0 ){
        for( let hit of r.hits.hits ){
            let toDel: PartialJurisprudenciaDocument = {};
            for( let key in hit._source ){
                let v = hit._source[key as JurisprudenciaDocumentKey];
                if(v === null) continue;
                else if(typeof v === "string"){
                    if( await isEmptyString(v) ){
                        toDel[key as JurisprudenciaDocumentKey] = null
                    }
                }
                else if(v && "Original" in v && "Show" in v && "Index" in v){ // v should be generic field
                    if( await isEmptyGenericField(v as GenericField) ){
                        toDel[key as JurisprudenciaDocumentKey] = null
                    }
                }
                else{
                    console.log("WAT",key,v,hit._id)
                }
            }
            if( Object.keys(toDel).length > 0 ){
               await bup.update(hit._id, toDel)
            }
        }
        r = await client.scroll({scroll: "2m", scroll_id: r._scroll_id});
    }

    await bup.close()

});

async function isEmptyGenericField(obj: GenericField){
    let r = true;
    for( let v of obj.Index ){
        r &&= await isEmptyString(v);
        if( !r ) break
    }
    for( let v of obj.Show ){
        r &&= await isEmptyString(v);
        if( !r ) break
    }
    return r;
}

function isEmptyString(text: string){
    let trimed = text.trim();
    return trimed.trim().length === 0 || trimed.trim().startsWith("«sem") || isHTMLEmpty(trimed)
}

function isHTMLEmpty(text: string){
    return client.indices.analyze({
        tokenizer: "keyword",
        char_filter: ["html_strip"],
        filter: ["trim"],
        text: text
    }).then(r => r.tokens ? r.tokens.every(t => t.token.length === 0) : false)
}